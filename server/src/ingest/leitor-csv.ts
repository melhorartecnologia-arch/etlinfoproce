import fs from 'node:fs';
import zlib from 'node:zlib';
import { parse } from 'csv-parse';

/**
 * Colunas que o pipeline usa do arquivo da InfoPrice. O arquivo traz 42
 * colunas; estas são as que alimentam staging e fato. As demais seguem
 * preservadas no campo `payload`, então nada se perde na rastreabilidade.
 */
export const COLUNAS_OBRIGATORIAS = [
  'gtin',
  'descricao',
  'id_loja',
  'preco',
  'data_coleta',
] as const;

/** Sinônimos aceitos no cabeçalho, para absorver variação da origem. */
const SINONIMOS: Record<string, string> = {
  ean: 'gtin',
  codigo_barras: 'gtin',
  cod_barras: 'gtin',
  produto: 'descricao',
  descricao_produto: 'descricao',
  nome_produto: 'descricao',
  loja: 'id_loja',
  codigo_loja: 'id_loja',
  cod_loja: 'id_loja',
  id_estabelecimento: 'id_loja',
  rede_loja: 'rede',
  bandeira: 'rede',
  estado: 'uf',
  sigla_uf: 'uf',
  cidade: 'municipio',
  valor: 'preco',
  preco_regular: 'preco',
  preco_venda: 'preco',
  valor_promocional: 'preco_promocional',
  preco_promo: 'preco_promocional',
  tipo: 'tipo_preco',
  tipo_de_preco: 'tipo_preco',
  data: 'data_coleta',
  dt_coleta: 'data_coleta',
  data_pesquisa: 'data_coleta',
};

export function normalizarCabecalho(nome: string): string {
  const limpo = nome
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return SINONIMOS[limpo] ?? limpo;
}

export interface LinhaLida {
  numeroLinha: number;
  campos: Record<string, string>;
  payload: string;
}

export interface ResultadoLeitura {
  cabecalho: string[];
  totalColunas: number;
  linhas: number;
}

/**
 * Lê um .csv.gz (ou .csv) e entrega as linhas em lotes.
 *
 * O arquivo é processado em streaming: um arquivo de 160 MB comprimido nunca
 * é materializado inteiro em memória. O `for await` aplica contrapressão, então
 * a leitura anda no ritmo do COPY para o banco.
 */
export async function lerCsv(
  caminho: string,
  aoLote: (lote: LinhaLida[]) => Promise<void>,
  tamanhoLote = 5_000,
): Promise<ResultadoLeitura> {
  const entrada = fs.createReadStream(caminho);
  const bytes = caminho.endsWith('.gz')
    ? entrada.pipe(zlib.createGunzip())
    : entrada;

  const analisador = bytes.pipe(
    parse({
      bom: true,
      delimiter: [';', ',', '\t'],
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: true,
      trim: true,
    }),
  );

  let cabecalho: string[] = [];
  let numeroLinha = 0;
  let lote: LinhaLida[] = [];

  try {
    for await (const registro of analisador as AsyncIterable<string[]>) {
      if (cabecalho.length === 0) {
        cabecalho = registro.map(normalizarCabecalho);
        continue;
      }

      numeroLinha += 1;
      const campos: Record<string, string> = {};
      cabecalho.forEach((coluna, i) => {
        if (coluna) campos[coluna] = registro[i] ?? '';
      });

      lote.push({
        numeroLinha,
        campos,
        // O payload guarda a linha como veio, para a tela de rejeições poder
        // mostrar o original.
        payload: registro.join(';'),
      });

      if (lote.length >= tamanhoLote) {
        await aoLote(lote);
        lote = [];
      }
    }

    if (lote.length > 0) await aoLote(lote);
  } finally {
    // Se o consumidor abortar, fecha os descritores em vez de deixá-los presos.
    entrada.destroy();
  }

  return {
    cabecalho,
    totalColunas: cabecalho.length,
    linhas: numeroLinha,
  };
}
