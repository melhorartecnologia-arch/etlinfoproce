import { pipeline } from 'node:stream/promises';
import { stringify } from 'csv-stringify';
import copiar from 'pg-copy-streams';
import type { Cliente } from '../db/pool.js';
import { lerCsv } from './leitor-csv.js';
import { COLUNAS_ORIGEM } from './colunas-origem.js';

const { from: copyFrom } = copiar;

/** Ordem das colunas do COPY — precisa bater com a lista no comando. */
const COLUNAS_STAGING = [
  'id_execucao',
  'id_arquivo',
  'arquivo',
  'numero_linha',
  'run_date',
  'gtin',
  'descricao',
  'id_loja',
  'rede',
  'uf',
  'municipio',
  'preco',
  'preco_promocional',
  'tipo_preco',
  'data_coleta',
  'fonte',
  'payload',
  'erro_leitura',
  // As demais colunas do arquivo, como texto; o merge converte cada uma.
  ...COLUNAS_ORIGEM.map((c) => c.nome),
];

export interface ParametrosCarga {
  cliente: Cliente;
  idExecucao: number;
  idArquivo: number;
  arquivo: string;
  caminhoLocal: string;
  runDate: string;
  fonte: string;
  /** Chamado a cada lote lido: lança se a parada da coleta foi pedida. */
  verificar?: () => Promise<void>;
  /** Chamado a cada lote enviado ao COPY, com o total de linhas até ali. */
  aoProgresso?: (linhas: number) => Promise<void>;
}

export interface ResultadoCarga {
  linhas: number;
  colunas: number;
  cabecalho: string[];
  /** Linhas com aspas fora do padrão que ainda assim foram lidas. */
  recuperadas: number;
  /** Linhas que não puderam ser lidas; entram marcadas com erro_leitura. */
  malformadas: number;
}

/**
 * Carrega um arquivo inteiro em stg_isa_infopanel_preco via COPY FROM STDIN.
 *
 * Tudo entra como texto: a conversão de tipos acontece depois, nas regras de
 * qualidade, para que uma linha malformada vire uma rejeição rastreável em vez
 * de abortar o COPY do arquivo inteiro.
 */
export async function carregarArquivoEmStaging(
  p: ParametrosCarga,
): Promise<ResultadoCarga> {
  const destino = p.cliente.query(
    copyFrom(
      `COPY infoprice.stg_isa_infopanel_preco (${COLUNAS_STAGING.join(', ')})
       FROM STDIN WITH (FORMAT csv)`,
    ),
  );

  // Strings sempre entre aspas: assim um campo vazio chega como '' e não como
  // NULL, e as regras de qualidade tratam ausência de valor de um jeito só.
  const gerador = stringify({ quoted_string: true });

  let falhaCopy: unknown = null;
  const copia = pipeline(gerador, destino).catch((erro) => {
    falhaCopy = erro;
    throw erro;
  });
  // A rejeição é tratada abaixo; este catch evita um unhandled rejection
  // enquanto ainda estamos lendo o arquivo.
  copia.catch(() => undefined);

  // Se o COPY morrer no meio, sair do 'drain' evita travar a leitura.
  const esperarVazao = () =>
    Promise.race([
      new Promise<void>((r) => gerador.once('drain', () => r())),
      copia.then(
        () => undefined,
        () => undefined,
      ),
    ]);

  let enviadas = 0;

  try {
    const resultado = await lerCsv(p.caminhoLocal, async (lote) => {
      await p.verificar?.();
      for (const linha of lote) {
        if (falhaCopy) throw falhaCopy;
        const c = linha.campos;
        const podeContinuar = gerador.write([
          p.idExecucao,
          p.idArquivo,
          p.arquivo,
          linha.numeroLinha,
          p.runDate,
          c.gtin ?? '',
          c.descricao ?? '',
          c.id_loja ?? '',
          c.rede ?? '',
          c.uf ?? '',
          c.municipio ?? '',
          c.preco ?? '',
          c.preco_promocional ?? '',
          c.tipo_preco ?? '',
          c.data_coleta ?? '',
          p.fonte,
          linha.payload,
          // null sai sem aspas, e o COPY em CSV lê campo vazio sem aspas como NULL.
          linha.erro ?? null,
          ...COLUNAS_ORIGEM.map((c) => linha.brutos[c.origem] ?? ''),
        ]);
        if (!podeContinuar) await esperarVazao();
      }
      enviadas += lote.length;
      await p.aoProgresso?.(enviadas);
    });

    gerador.end();
    await copia;

    return {
      linhas: resultado.linhas,
      colunas: resultado.totalColunas,
      cabecalho: resultado.cabecalho,
      recuperadas: resultado.recuperadas,
      malformadas: resultado.malformadas,
    };
  } catch (erro) {
    gerador.destroy();
    await copia.catch(() => undefined);
    throw erro;
  }
}

/**
 * Limpa o staging do arquivo antes de recarregá-lo.
 * É o que torna a reexecução segura: o espelho do arquivo é reconstruído do
 * zero em vez de acumular linhas de tentativas anteriores. O id do arquivo é
 * estável entre execuções (identidade pasta + nome em ctl_arquivo).
 */
export async function limparStagingArquivo(
  cliente: Cliente,
  idArquivo: number,
): Promise<void> {
  await cliente.query(
    'DELETE FROM infoprice.stg_isa_infopanel_preco WHERE id_arquivo = $1',
    [idArquivo],
  );
}
