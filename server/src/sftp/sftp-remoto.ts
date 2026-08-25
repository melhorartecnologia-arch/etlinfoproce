import fs from 'node:fs/promises';
import path from 'node:path';
import SftpClient from 'ssh2-sftp-client';
import { config } from '../config.js';
import type { ArquivoRemoto, DriverOrigem, PastaRemota } from './driver.js';

/**
 * Acesso ao SFTP do fornecedor.
 *
 * A autenticação preferida é por chave privada .pem — a senha só é usada se
 * nenhuma chave estiver configurada. Nem uma nem outra são versionadas: vêm do
 * ambiente, que por sua vez lê do cofre de segredos.
 */
export class SftpRemoto implements DriverOrigem {
  readonly rotulo = `${config.sftp.usuario}@${config.sftp.host}:${config.sftp.porta}`;

  private cliente: SftpClient | null = null;

  private async credenciais(): Promise<SftpClient.ConnectOptions> {
    const base: SftpClient.ConnectOptions = {
      host: config.sftp.host,
      port: config.sftp.porta,
      username: config.sftp.usuario,
      readyTimeout: config.sftp.timeoutMs,
      // Mantém a sessão viva durante downloads longos (a carga histórica
      // levou mais de 6 horas).
      keepaliveInterval: 10_000,
      keepaliveCountMax: 6,
    };

    if (config.sftp.chavePrivada) {
      const chave = await fs.readFile(config.sftp.chavePrivada);
      return {
        ...base,
        privateKey: chave,
        passphrase: config.sftp.chavePassphrase || undefined,
      };
    }

    if (config.sftp.senha) {
      return { ...base, password: config.sftp.senha };
    }

    throw new Error(
      'nenhuma credencial SFTP configurada: defina SFTP_CHAVE_PRIVADA (preferido) ou SFTP_SENHA',
    );
  }

  async conectar(): Promise<void> {
    if (this.cliente) return;
    const cliente = new SftpClient('console-ingestao');
    await cliente.connect(await this.credenciais());
    this.cliente = cliente;
  }

  private exigirCliente(): SftpClient {
    if (!this.cliente) throw new Error('SFTP não conectado');
    return this.cliente;
  }

  async listarPastas(): Promise<PastaRemota[]> {
    const cliente = this.exigirCliente();
    const base = config.sftp.diretorioBase;
    const itens = await cliente.list(base);

    const pastas: PastaRemota[] = [];
    for (const item of itens) {
      if (item.type !== 'd') continue;
      const m = config.coleta.padraoPasta.exec(item.name);
      if (!m) continue;
      pastas.push({
        nome: item.name,
        runDate: m[1]!,
        caminho: `${base}/${item.name}`,
        modificadoEm: item.modifyTime ? new Date(item.modifyTime) : null,
      });
    }
    // Mais recente primeiro.
    pastas.sort((a, b) => b.runDate.localeCompare(a.runDate));
    return pastas;
  }

  async listarArquivos(caminhoPasta: string): Promise<ArquivoRemoto[]> {
    const cliente = this.exigirCliente();
    const itens = await cliente.list(caminhoPasta);
    return itens
      .filter((i) => i.type === '-')
      .map((i) => ({
        nome: i.name,
        caminho: `${caminhoPasta}/${i.name}`,
        tamanhoBytes: i.size,
        modificadoEm: i.modifyTime ? new Date(i.modifyTime) : null,
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }

  async baixar(caminhoRemoto: string, destinoLocal: string): Promise<number> {
    const cliente = this.exigirCliente();
    await fs.mkdir(path.dirname(destinoLocal), { recursive: true });
    await cliente.fastGet(caminhoRemoto, destinoLocal, {
      concurrency: 8,
      chunkSize: 32 * 1024,
    });
    const info = await fs.stat(destinoLocal);
    return info.size;
  }

  async desconectar(): Promise<void> {
    if (!this.cliente) return;
    try {
      await this.cliente.end();
    } finally {
      this.cliente = null;
    }
  }
}
