import type { Cliente } from '../db/pool.js';

export interface ContagemArquivo {
  idArquivo: number;
  inseridas: number;
  atualizadas: number;
}

export interface ResultadoMerge {
  inseridas: number;
  atualizadas: number;
  gravadas: number;
  particoes: string[];
  porArquivo: Map<number, ContagemArquivo>;
}

/**
 * O comando de persistência exibido na tela de detalhe da execução.
 * Fica aqui, junto de quem o executa, para que a tela nunca mostre um SQL
 * diferente do que o pipeline realmente roda.
 */
export const SQL_PERSISTENCIA = `INSERT INTO infoprice.fact_preco_coletado AS f
SELECT * FROM infoprice.stg_isa_infopanel_preco
WHERE run_date = DATE '{run}'
ON CONFLICT (gtin, id_loja, data_coleta, fonte)
DO UPDATE SET preco = EXCLUDED.preco,
              id_execucao = EXCLUDED.id_execucao,
              atualizado_em = now()
WHERE f.preco IS DISTINCT FROM EXCLUDED.preco;`;

/**
 * Cria as partições mensais necessárias para as datas que serão gravadas.
 *
 * Só conta as linhas que passaram pelas regras: uma data absurda vinda de um
 * arquivo defeituoso já foi rejeitada e não deve criar partição.
 */
async function garantirParticoes(
  cliente: Cliente,
  idExecucao: number,
): Promise<string[]> {
  const { rows } = await cliente.query<{ mes: string }>(
    `SELECT DISTINCT date_trunc('month', infoprice.para_data(s.data_coleta))::date::text AS mes
       FROM infoprice.stg_isa_infopanel_preco s
      WHERE s.id_execucao = $1
        AND infoprice.para_data(s.data_coleta) IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM infoprice.ctl_rejeicao r
           WHERE r.id_execucao = s.id_execucao
             AND r.arquivo = s.arquivo
             AND r.numero_linha = s.numero_linha
        )
      ORDER BY 1`,
    [idExecucao],
  );

  const particoes: string[] = [];
  for (const linha of rows) {
    const { rows: r } = await cliente.query<{ garantir_particao: string }>(
      'SELECT infoprice.garantir_particao($1::date)',
      [linha.mes],
    );
    if (r[0]) particoes.push(r[0].garantir_particao);
  }
  return particoes;
}

/**
 * Promove o staging para a tabela final.
 *
 * Só entram as linhas que passaram pelas regras de qualidade. O UPSERT usa a
 * chave (gtin, id_loja, data_coleta, fonte); a cláusula WHERE final faz com que
 * uma linha idêntica à que já está gravada não conte como atualização — é o que
 * permite reexecutar o mesmo run sem inflar as contagens.
 *
 * Inserção e atualização são distinguidas por `criado_em = atualizado_em`:
 * dentro de uma transação `now()` é constante, então a linha recém-inserida tem
 * os dois carimbos iguais e a atualizada não. (O truque usual, `xmax = 0`, não
 * serve aqui — o PostgreSQL não expõe colunas de sistema dentro de uma CTE.)
 */
export async function mergeIncremental(
  cliente: Cliente,
  idExecucao: number,
): Promise<ResultadoMerge> {
  const particoes = await garantirParticoes(cliente, idExecucao);

  const { rows } = await cliente.query<{
    id_arquivo: number;
    inseridas: number;
    atualizadas: number;
  }>(
    `WITH limpas AS (
       SELECT s.gtin,
              s.id_loja,
              infoprice.para_data(s.data_coleta)      AS data_coleta,
              s.fonte,
              NULLIF(btrim(s.descricao), '')          AS descricao,
              NULLIF(btrim(s.rede), '')               AS rede,
              NULLIF(btrim(s.uf), '')                 AS uf,
              NULLIF(btrim(s.municipio), '')          AS municipio,
              infoprice.para_numero(s.preco)          AS preco,
              infoprice.para_numero(s.preco_promocional) AS preco_promocional,
              COALESCE(NULLIF(btrim(s.tipo_preco), ''), 'Regular') AS tipo_preco,
              s.id_execucao,
              s.id_arquivo,
              s.numero_linha
         FROM infoprice.stg_isa_infopanel_preco s
        WHERE s.id_execucao = $1
          AND NOT EXISTS (
            SELECT 1 FROM infoprice.ctl_rejeicao r
             WHERE r.id_execucao = s.id_execucao
               AND r.arquivo = s.arquivo
               AND r.numero_linha = s.numero_linha
          )
     ),
     gravadas AS (
       INSERT INTO infoprice.fact_preco_coletado AS f (
         gtin, id_loja, data_coleta, fonte, descricao, rede, uf, municipio,
         preco, preco_promocional, tipo_preco, id_execucao, id_arquivo, numero_linha
       )
       SELECT gtin, id_loja, data_coleta, fonte, descricao, rede, uf, municipio,
              preco, preco_promocional, tipo_preco, id_execucao, id_arquivo, numero_linha
         FROM limpas
       ON CONFLICT (gtin, id_loja, data_coleta, fonte) DO UPDATE
          SET preco             = EXCLUDED.preco,
              preco_promocional = EXCLUDED.preco_promocional,
              tipo_preco        = EXCLUDED.tipo_preco,
              descricao         = COALESCE(EXCLUDED.descricao, f.descricao),
              rede              = COALESCE(EXCLUDED.rede, f.rede),
              uf                = COALESCE(EXCLUDED.uf, f.uf),
              municipio         = COALESCE(EXCLUDED.municipio, f.municipio),
              id_execucao       = EXCLUDED.id_execucao,
              id_arquivo        = EXCLUDED.id_arquivo,
              numero_linha      = EXCLUDED.numero_linha,
              atualizado_em     = now()
        WHERE f.preco             IS DISTINCT FROM EXCLUDED.preco
           OR f.preco_promocional IS DISTINCT FROM EXCLUDED.preco_promocional
           OR f.tipo_preco        IS DISTINCT FROM EXCLUDED.tipo_preco
       RETURNING f.id_arquivo, (f.criado_em = f.atualizado_em) AS foi_insert
     )
     SELECT id_arquivo,
            count(*) FILTER (WHERE foi_insert)::bigint     AS inseridas,
            count(*) FILTER (WHERE NOT foi_insert)::bigint AS atualizadas
       FROM gravadas
      GROUP BY id_arquivo`,
    [idExecucao],
  );

  const porArquivo = new Map<number, ContagemArquivo>();
  let inseridas = 0;
  let atualizadas = 0;

  for (const linha of rows) {
    porArquivo.set(linha.id_arquivo, {
      idArquivo: linha.id_arquivo,
      inseridas: linha.inseridas,
      atualizadas: linha.atualizadas,
    });
    inseridas += linha.inseridas;
    atualizadas += linha.atualizadas;
  }

  return {
    inseridas,
    atualizadas,
    gravadas: inseridas + atualizadas,
    particoes,
    porArquivo,
  };
}

export interface ContagemStagingArquivo {
  idArquivo: number;
  arquivo: string;
  staging: number;
  rejeitadas: number;
}

/** Linhas em staging e rejeitadas por arquivo — contagens exatas, sem heurística. */
export async function contagensStagingPorArquivo(
  cliente: Cliente,
  idExecucao: number,
): Promise<ContagemStagingArquivo[]> {
  const { rows } = await cliente.query<{
    idArquivo: number;
    arquivo: string;
    staging: number;
    rejeitadas: number;
  }>(
    `SELECT s.id_arquivo        AS "idArquivo",
            s.arquivo           AS arquivo,
            count(*)::bigint    AS staging,
            count(r.id)::bigint AS rejeitadas
       FROM infoprice.stg_isa_infopanel_preco s
       LEFT JOIN infoprice.ctl_rejeicao r
              ON r.id_execucao = s.id_execucao
             AND r.arquivo = s.arquivo
             AND r.numero_linha = s.numero_linha
      WHERE s.id_execucao = $1
      GROUP BY s.id_arquivo, s.arquivo
      ORDER BY s.arquivo`,
    [idExecucao],
  );
  return rows;
}
