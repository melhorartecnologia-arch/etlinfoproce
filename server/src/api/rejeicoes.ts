import type {
  CamposRejeicao,
  DetalheRejeicaoResposta,
  OpcaoExecucao,
  RejeicaoExplicada,
} from '@infoprice/shared';
import { consultar, consultarUm } from '../db/pool.js';
import { interpretarLinha } from '../ingest/leitor-csv.js';
import { explicarRejeicao } from '../ingest/explicar-rejeicao.js';

export interface FiltroRejeicoes {
  idExecucao: number;
  motivo?: string;
  arquivo?: string;
  /** Trecho procurado na linha original (GTIN, loja, descrição…). */
  busca?: string;
}

interface LinhaRejeicao {
  id: number;
  idExecucao: number;
  arquivo: string;
  numeroLinha: number;
  motivo: string;
  payload: string;
  tratamento: string;
  criadoEm: string;
  runDate: string;
  cabecalho: string | null;
  delimitador: string | null;
}

const CAMPOS_EXIBIDOS = ['gtin', 'descricao', 'id_loja', 'preco', 'preco_promocional', 'data_coleta'] as const;

function onde(f: FiltroRejeicoes): { sql: string; valores: unknown[] } {
  const valores: unknown[] = [f.idExecucao];
  const partes = ['r.id_execucao = $1'];
  if (f.motivo) {
    valores.push(f.motivo);
    partes.push(`r.motivo = $${valores.length}`);
  }
  if (f.arquivo) {
    valores.push(f.arquivo);
    partes.push(`r.arquivo = $${valores.length}`);
  }
  if (f.busca) {
    valores.push(`%${f.busca}%`);
    partes.push(`r.payload ILIKE $${valores.length}`);
  }
  return { sql: partes.join(' AND '), valores };
}

const SELECT = `
  SELECT r.id,
         r.id_execucao  AS "idExecucao",
         r.arquivo,
         r.numero_linha AS "numeroLinha",
         r.motivo,
         r.payload,
         r.tratamento,
         r.criado_em    AS "criadoEm",
         e.run_date::text AS "runDate",
         a.cabecalho,
         a.delimitador
    FROM infoprice.ctl_rejeicao r
    JOIN infoprice.ctl_execucao e ON e.id = r.id_execucao
    LEFT JOIN infoprice.ctl_arquivo a ON a.id = r.id_arquivo`;

/** Reinterpreta a linha e explica a rejeição com os valores dela. */
function explicar(l: LinhaRejeicao) {
  const linha = interpretarLinha(l.cabecalho, l.delimitador, l.payload);
  const campos: CamposRejeicao = {};
  // Numa linha malformada as colunas estão deslocadas: o "GTIN" seria o valor
  // de outra coluna. Melhor não mostrar nada do que mostrar errado.
  if (l.motivo !== 'Linha malformada no arquivo') {
    for (const c of CAMPOS_EXIBIDOS) if (linha.campos[c]) campos[c] = linha.campos[c];
  }
  const { runDate: _r, cabecalho: _c, delimitador: _d, ...base } = l;
  const rejeicao: RejeicaoExplicada = {
    ...base,
    explicacao: explicarRejeicao(l.motivo, linha, l.runDate),
    campos,
  };
  return { rejeicao, linha };
}

export async function listarRejeicoes(
  f: FiltroRejeicoes,
  pagina: number,
  porPagina: number,
): Promise<{ rejeicoes: RejeicaoExplicada[]; filtradas: number }> {
  const w = onde(f);
  const [total, linhas] = await Promise.all([
    consultarUm<{ n: string }>(
      `SELECT count(*) AS n FROM infoprice.ctl_rejeicao r WHERE ${w.sql}`,
      w.valores,
    ),
    consultar<LinhaRejeicao>(
      `${SELECT}
        WHERE ${w.sql}
        -- Por arquivo e linha: as regras rodam em sequência, e ordenar por id
        -- agruparia tudo por motivo.
        ORDER BY r.arquivo, r.numero_linha
        LIMIT ${porPagina} OFFSET ${(pagina - 1) * porPagina}`,
      w.valores,
    ),
  ]);
  return {
    rejeicoes: linhas.map((l) => explicar(l).rejeicao),
    filtradas: Number(total?.n ?? 0),
  };
}

/** Todas as rejeições que atendem ao filtro, já explicadas — para o CSV. */
export async function todasRejeicoes(f: FiltroRejeicoes): Promise<RejeicaoExplicada[]> {
  const w = onde(f);
  const linhas = await consultar<LinhaRejeicao>(
    `${SELECT} WHERE ${w.sql} ORDER BY r.arquivo, r.numero_linha`,
    w.valores,
  );
  return linhas.map((l) => explicar(l).rejeicao);
}

export async function detalheRejeicao(id: number): Promise<DetalheRejeicaoResposta | null> {
  const l = await consultarUm<LinhaRejeicao>(`${SELECT} WHERE r.id = $1`, [id]);
  if (!l) return null;
  const { rejeicao, linha } = explicar(l);
  return {
    rejeicao,
    runDate: l.runDate,
    colunas: linha.colunas,
    colunasEsperadas: linha.colunasEsperadas,
    colunasLidas: linha.colunasLidas,
    delimitador: l.delimitador,
    cabecalhoConhecido: l.cabecalho !== null,
  };
}

export async function motivosDaExecucao(f: FiltroRejeicoes) {
  // Os motivos respeitam arquivo e busca, mas não o próprio filtro de motivo:
  // a lista serve para trocar de motivo.
  const w = onde({ ...f, motivo: undefined });
  const linhas = await consultar<{ nome: string; quantidade: string }>(
    `SELECT r.motivo AS nome, count(*) AS quantidade
       FROM infoprice.ctl_rejeicao r WHERE ${w.sql}
      GROUP BY r.motivo ORDER BY count(*) DESC`,
    w.valores,
  );
  return linhas.map((m) => ({ nome: m.nome, quantidade: Number(m.quantidade) }));
}

export async function arquivosComRejeicao(idExecucao: number) {
  const linhas = await consultar<{ nome: string; quantidade: string }>(
    `SELECT arquivo AS nome, count(*) AS quantidade
       FROM infoprice.ctl_rejeicao WHERE id_execucao = $1
      GROUP BY arquivo ORDER BY arquivo`,
    [idExecucao],
  );
  return linhas.map((a) => ({ nome: a.nome, quantidade: Number(a.quantidade) }));
}

export async function execucoesRecentes(): Promise<OpcaoExecucao[]> {
  const linhas = await consultar<OpcaoExecucao & { linhasRejeitadas: string }>(
    `SELECT id, run_date::text AS "runDate", status, iniciado_em AS "iniciadoEm",
            linhas_rejeitadas AS "linhasRejeitadas"
       FROM infoprice.ctl_execucao
      ORDER BY id DESC
      LIMIT 60`,
  );
  return linhas.map((e) => ({ ...e, linhasRejeitadas: Number(e.linhasRejeitadas) }));
}
