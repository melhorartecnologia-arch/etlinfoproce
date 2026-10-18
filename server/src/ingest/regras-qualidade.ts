import { config } from '../config.js';
import type { Cliente } from '../db/pool.js';

/**
 * As regras de qualidade, aplicadas em conjunto sobre o staging.
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
    // Primeira de propósito: a linha que não pôde ser lida chega com as colunas
    // vazias, e qualquer regra seguinte a pegaria com o motivo errado.
    motivo: 'Linha malformada no arquivo',
    tratamento: 'Aguardando correção na origem',
    condicao: `s.erro_leitura IS NOT NULL`,
  },
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
    // A tabela final guarda numeric(12,2). Um valor maior estouraria no merge e
    // reverteria o arquivo inteiro por causa de uma linha.
    motivo: 'Preço acima do limite',
    tratamento: 'Aguardando correção na origem',
    condicao: `abs(infoprice.para_numero(s.preco)) >= 10000000000
               OR abs(infoprice.para_numero(s.preco_promocional)) >= 10000000000`,
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
    // O arquivo traz o último preço visto em cada loja, que pode ter meses:
    // vale até JANELA_COLETA_DIAS antes do run. Data no futuro é erro de origem.
    condicao: `infoprice.para_data(s.data_coleta) IS NULL
               OR infoprice.para_data(s.data_coleta) > s.run_date
               OR infoprice.para_data(s.data_coleta)
                    < s.run_date - ${Math.max(0, Math.trunc(config.coleta.janelaColetaDias))}`,
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

/**
 * Cadastra em dim_loja as lojas do arquivo que ainda não estão lá, com a rede,
 * a UF e a cidade que o próprio arquivo informa. Roda antes das regras, para
 * que "Loja ausente em dim_loja" só pegue a linha sem loja.
 */
export async function cadastrarLojasNovas(
  cliente: Cliente,
  idExecucao: number,
  idArquivo: number,
): Promise<number> {
  const { rowCount } = await cliente.query(
    `INSERT INTO infoprice.dim_loja (id_loja, rede, nome, uf, cidade)
     SELECT DISTINCT ON (s.id_loja)
            s.id_loja,
            NULLIF(btrim(s.rede), ''),
            s.id_loja,
            NULLIF(btrim(s.uf), ''),
            NULLIF(btrim(s.municipio), '')
       FROM infoprice.stg_isa_infopanel_preco s
      WHERE s.id_execucao = $1
        AND s.id_arquivo = $2
        AND s.erro_leitura IS NULL
        AND btrim(coalesce(s.id_loja, '')) <> ''
      ORDER BY s.id_loja
     ON CONFLICT (id_loja) DO NOTHING`,
    [idExecucao, idArquivo],
  );
  return rowCount ?? 0;
}

export interface ContagemMotivo {
  motivo: string;
  quantidade: number;
}

/**
 * Aplica as regras às linhas de um arquivo e grava as reprovações em
 * ctl_rejeicao. Devolve a contagem por motivo, na ordem em que as regras
 * rodaram.
 *
 * A duplicidade é avaliada dentro do arquivo. A mesma chave repetida em outro
 * arquivo do run não é rejeitada: o merge do arquivo seguinte a atualiza, e a
 * última ocorrência prevalece do mesmo jeito.
 */
export async function aplicarRegrasQualidade(
  cliente: Cliente,
  idExecucao: number,
  idArquivo: number,
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
          AND s.id_arquivo = $4
          AND (${regra.condicao})
          AND ${jaRejeitada}`,
      [idExecucao, regra.motivo, regra.tratamento, idArquivo],
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
                ORDER BY s.numero_linha DESC
              ) AS posicao
         FROM infoprice.stg_isa_infopanel_preco s
        WHERE s.id_execucao = $1
          AND s.id_arquivo = $4
          AND ${jaRejeitada}
     )
     INSERT INTO infoprice.ctl_rejeicao
       (id_execucao, id_arquivo, arquivo, numero_linha, motivo, payload, tratamento)
     SELECT v.id_execucao, v.id_arquivo, v.arquivo, v.numero_linha, $2, v.payload, $3
       FROM validas v
      WHERE v.posicao > 1`,
    [idExecucao, REGRA_DUPLICIDADE.motivo, REGRA_DUPLICIDADE.tratamento, idArquivo],
  );
  contagens.push({
    motivo: REGRA_DUPLICIDADE.motivo,
    quantidade: dup ?? 0,
  });

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
