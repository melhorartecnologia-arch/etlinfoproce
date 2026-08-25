/** Uma pasta run=AAAA-MM-DD encontrada no diretório base. */
export interface PastaRemota {
  nome: string;
  runDate: string;
  caminho: string;
  modificadoEm: Date | null;
}

/** Um arquivo dentro de uma pasta run=. */
export interface ArquivoRemoto {
  nome: string;
  caminho: string;
  tamanhoBytes: number;
  modificadoEm: Date | null;
}

/**
 * Contrato de acesso à origem. Existem duas implementações: a real, sobre
 * ssh2-sftp-client, e a local, que lê um diretório do disco. A segunda deixa
 * o pipeline inteiro — download, hash, COPY, upsert — rodar em
 * desenvolvimento e em teste sem depender do servidor do fornecedor.
 */
export interface DriverOrigem {
  readonly rotulo: string;
  conectar(): Promise<void>;
  listarPastas(): Promise<PastaRemota[]>;
  listarArquivos(caminhoPasta: string): Promise<ArquivoRemoto[]>;
  /** Baixa para `destinoLocal` e devolve o número de bytes escritos. */
  baixar(caminhoRemoto: string, destinoLocal: string): Promise<number>;
  desconectar(): Promise<void>;
}
