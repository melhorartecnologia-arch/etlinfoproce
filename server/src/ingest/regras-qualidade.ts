import type { Cliente } from '../db/pool.js';

/**
 * As seis regras de qualidade, aplicadas em conjunto sobre o staging.
 *
 * Cada regra é uma consulta que seleciona as linhas reprovadas e as grava em
 * ctl_rejeicao com o payload original. Rodam em ordem: a primeira que pega uma
 * linha é a dona da rejeição, então uma linha nunca aparece duas vezes com
 * motivos diferentes.
 */
interface Regra {
  motivo: string;
  tratamento: string;
  /** Condição SQL que identifica a linha *reprovada*, sobre o alias `s`. */
  condicao: string;
}

const REGRAS: Regra[] = [
  {
    motivo: 'GTIN inválido no dígito verificador',
    tratamento: 'Aguardando correção na origem',
    condicao: `NOT infoprice.gtin_valido(s.gtin)`,
  },
  {
    motivo: 'Preço menor ou igual a zero',
    tratamento: 'Descartada por regra',
    condicao: `infoprice.para_numero(s.preco) IS NULL OR infoprice.para_numero(s.preco) <= 0`,
  },
  {
    motivo: 'Loja ausente em dim_loja',
    tratamento: 'Cadastro de loja solicitado',
    condicao: `s.id_loja IS NULL
               OR btrim(s.id_loja) = ''
               OR NOT EXISTS (
                 SELECT 1 FROM infoprice.dim_loja d WHERE d.id_loja = s.id_loja
               )`,
  },
  {
    motivo: 'Data de coleta fora da janela do run',
    tratamento: 'Reenfileirada para run correto',
    // A coleta do dia pode trazer preços apurados na véspera; qualquer coisa
    // fora dessa janela de dois dias é erro de origem.
    condicao: `infoprice.para_data(s.data_coleta) IS NULL
               OR infoprice.para_data(s.data_coleta) > s.run_date
               OR infoprice.para_data(s.data_coleta) < s.run_date - INTERVAL '1 day'`,
  },
  {
    motivo: 'Caractere inválido na descrição',
    tratamento: 'Normalizada e reprocessada',
    // Três sintomas de encoding quebrado: a sequência \xNN literal que sobra
    // quando o arquivo vem em latin-1 lido como utf-8, caracteres de controle
    // no meio do texto, e o caractere de substituição U+FFFD.
    condicao: `s.descricao ~ '\\\\x[0-9A-Fa-f]{2}'
               OR s.descricao ~ '[[:cntrl:]]'
               OR s.descricao LIKE '%' || chr(65533) || '%'`,
  },
];

/**
 * A duplicidade é tratada à parte: não é uma condição por linha, e sim a
 * segunda ocorrência em diante dentro da mesma chave de conflito.
 */
const REGRA_DUPLICIDADE = {
  motivo: 'Duplicidade na chave de conflito',
  tratamento: 'Última ocorrência mantida',
};

export interface ContagemMotivo {
  motivo: string;
  quantidade: number;
}

/**
 * Aplica as regras e grava as reprovações em ctl_rejeicao.
 * Devolve a contagem por motivo, na ordem em que as regras rodaram.
 */
export async function aplicarRegrasQualidade(
  cliente: Cliente,
  idExecucao: number,
  runDate: string,
): Promise<ContagemMotivo[]> {
  const contagens: ContagemMotivo[] = [];

  // Uma linha já rejeitada por uma regra anterior não é reavaliada.
  const jaRejeitada = `NOT EXISTS (
    SELECT 1 FROM infoprice.ctl_rejeicao r
     WHERE r.id_execucao = $1
       AND r.arquivo = s.arquivo
       AND r.numero_linha = s.numero_linha
  )`;

  for (const regra of REGRAS) {
    const { rowCount } = await cliente.query(
      `INSERT INTO infoprice.ctl_rejeicao
         (id_execucao, id_arquivo, arquivo, numero_linha, motivo, payload, tratamento)
       SELECT s.id_execucao, s.id_arquivo, s.arquivo, s.numero_linha, $2, s.payload, $3
         FROM infoprice.stg_isa_infopanel_preco s
        WHERE s.id_execucao = $1
          AND (${regra.condicao})
          AND ${jaRejeitada}`,
      [idExecucao, regra.motivo, regra.tratamento],
    );
    contagens.push({ motivo: regra.motivo, quantidade: rowCount ?? 0 });
  }

  // Duplicidade: mantém a última ocorrência (maior numero_linha) de cada chave
  // e rejeita as anteriores, entre as linhas que sobreviveram às demais regras.
  const { rowCount: dup } = await cliente.query(
    `WITH validas AS (
       SELECT s.*,
              row_number() OVER (
                PARTITION BY s.gtin, s.id_loja, infoprice.para_data(s.data_coleta), s.fonte
                ORDER BY s.numero_linha DESC, s.id_arquivo DESC
              ) AS posicao
         FROM infoprice.stg_isa_infopanel_preco s
        WHERE s.id_execucao = $1
          AND ${jaRejeitada}
     )
     INSERT INTO infoprice.ctl_rejeicao
       (id_execucao, id_arquivo, arquivo, numero_linha, motivo, payload, tratamento)
     SELECT v.id_execucao, v.id_arquivo, v.arquivo, v.numero_linha, $2, v.payload, $3
       FROM validas v
      WHERE v.posicao > 1`,
    [idExecucao, REGRA_DUPLICIDADE.motivo, REGRA_DUPLICIDADE.tratamento],
  );
  contagens.push({
    motivo: REGRA_DUPLICIDADE.motivo,
    quantidade: dup ?? 0,
  });

  void runDate;
  return contagens;
}

/** Total de linhas rejeitadas na execução. */
export async function totalRejeitadas(
  cliente: Cliente,
  idExecucao: number,
): Promise<number> {
  const { rows } = await cliente.query<{ total: number }>(
    'SELECT count(*)::bigint AS total FROM infoprice.ctl_rejeicao WHERE id_execucao = $1',
    [idExecucao],
  );
  return rows[0]?.total ?? 0;
}
