import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import type { ArquivoRemoto, DriverOrigem, PastaRemota } from './driver.js';

/**
 * Origem lida do disco, com a mesma interface do SFTP real.
 *
 * Serve para rodar o pipeline completo sem o servidor do fornecedor: as etapas
 * de download, hash, COPY e upsert são exatamente as mesmas — só a leitura dos
 * bytes muda. Configure com SFTP_DRIVER=local.
 */
export class OrigemLocal implements DriverOrigem {
  readonly rotulo = `arquivo local · ${config.sftp.diretorioLocal}`;

  private base = config.sftp.diretorioLocal;

  async conectar(): Promise<void> {
    try {
      const info = await fs.stat(this.base);
      if (!info.isDirectory()) {
        throw new Error(`${this.base} não é um diretório`);
      }
    } catch (erro) {
      const causa = erro instanceof Error ? erro.message : String(erro);
      throw new Error(
        `diretório de origem local indisponível (${this.base}): ${causa}. ` +
          'Rode `npm run gerar-fixtures --workspace server` para criar arquivos de exemplo.',
      );
    }
  }

  async listarPastas(): Promise<PastaRemota[]> {
    const itens = await fs.readdir(this.base, { withFileTypes: true });
    const pastas: PastaRemota[] = [];

    for (const item of itens) {
      if (!item.isDirectory()) continue;
      const m = config.coleta.padraoPasta.exec(item.name);
      if (!m) continue;
      const caminho = path.join(this.base, item.name);
      const info = await fs.stat(caminho);
      pastas.push({
        nome: item.name,
        runDate: m[1]!,
        caminho,
        modificadoEm: info.mtime,
      });
    }

    pastas.sort((a, b) => b.runDate.localeCompare(a.runDate));
    return pastas;
  }

  async listarArquivos(caminhoPasta: string): Promise<ArquivoRemoto[]> {
    const itens = await fs.readdir(caminhoPasta, { withFileTypes: true });
    const arquivos: ArquivoRemoto[] = [];

    for (const item of itens) {
      if (!item.isFile()) continue;
      const caminho = path.join(caminhoPasta, item.name);
      const info = await fs.stat(caminho);
      arquivos.push({
        nome: item.name,
        caminho,
        tamanhoBytes: info.size,
        modificadoEm: info.mtime,
      });
    }

    arquivos.sort((a, b) => a.nome.localeCompare(b.nome));
    return arquivos;
  }

  async baixar(caminhoRemoto: string, destinoLocal: string): Promise<number> {
    await fs.mkdir(path.dirname(destinoLocal), { recursive: true });
    await fs.copyFile(caminhoRemoto, destinoLocal);
    const info = await fs.stat(destinoLocal);
    return info.size;
  }

  async desconectar(): Promise<void> {
    // nada a fechar
  }
}
