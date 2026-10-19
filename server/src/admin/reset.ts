import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type { ContagensBase, UltimoReset } from '@infoprice/shared';
import { config } from '../config.js';
import { consultarUm, emTransacao, pool, type Cliente } from '../db/pool.js';

/** O que precisa ser digitado para confirmar, na tela e no terminal. */
export const FRASE_CONFIRMACAO = 'ZERAR TUDO';

/**
 * Tabelas de dado e de metadado operacional, apagadas por inteiro.
 *
 * Ficam de fora: ctl_regra_alerta e ctl_agendamento (configuração, não
 * histórico), ctl_reset (a trilha dos próprios resets) e public.schema_migrations
 * (o schema continua aplicado). Usuários e sessões só saem com a opção própria.
 *
 * O TRUNCATE vai sem CASCADE de propósito: se um dia uma tabela nova passar a
 * referenciar uma destas sem entrar na lista, o reset falha em vez de apagar
 * essa tabela em silêncio.
 */
const TABELAS_DADOS = [
  'stg_isa_infopanel_preco',
  'fact_preco_coletado',
  'ctl_rejeicao',
  'ctl_execucao_log',
  'ctl_execucao_etapa',
  'ctl_execucao_arquivo',
  'ctl_arquivo',
  'ctl_incidente',
  'ctl_watermark',
  'ctl_execucao',
  'dim_loja',
  'ctl_tentativa_login',
];

/** Contagens da base; dentro da transação do reset, pelo cliente dela. */
export async function contarBase(
  db: Pick<Cliente, 'query'> = pool,
): Promise<ContagensBase> {
  const { rows } = await db.query<Record<keyof ContagensBase, string>>(
    `SELECT
       (SELECT count(*) FROM infoprice.ctl_execucao)::bigint        AS execucoes,
       (SELECT count(*) FROM infoprice.ctl_arquivo)::bigint         AS arquivos,
       0::bigint                                                    AS precos,
       (SELECT count(*) FROM infoprice.ctl_rejeicao)::bigint        AS rejeicoes,
       (SELECT count(*) FROM infoprice.ctl_incidente)::bigint       AS incidentes,
       (SELECT count(*) FROM infoprice.dim_loja)::bigint            AS lojas,
       (SELECT count(*) FROM infoprice.ctl_execucao_log)::bigint    AS "eventosLog",
       (SELECT count(*) FROM infoprice.ctl_tentativa_login)::bigint AS "tentativasLogin",
       (SELECT count(*) FROM infoprice.ctl_usuario)::bigint         AS usuarios`,
  );
  const r = rows[0]!;
  const contagens = Object.fromEntries(
    Object.entries(r).map(([k, v]) => [k, Number(v)]),
  ) as unknown as ContagensBase;
  contagens.precos = await contarPrecos(db);
  return contagens;
}

/**
 * Linhas do fato. Contar o fato inteiro levaria minutos com volume real, então
 * vale a estimativa do PostgreSQL por partição — exceto na partição que ele
 * ainda não analisou (recém-carregada), em que a estimativa é zero e a tela de
 * confirmação diria que não há nada a apagar. Essa é contada de fato.
 */
async function contarPrecos(db: Pick<Cliente, 'query'>): Promise<number> {
  const { rows } = await db.query<{ nome: string; estimativa: number }>(
    `SELECT c.relname AS nome, c.reltuples AS estimativa
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
      WHERE i.inhparent = 'infoprice.fact_preco_coletado'::regclass`,
  );
  let total = 0;
  for (const p of rows) {
    if (p.estimativa > 0) {
      total += Math.round(p.estimativa);
    } else {
      const r = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM infoprice.${pg.escapeIdentifier(p.nome)}`,
      );
      total += Number(r.rows[0]?.n ?? 0);
    }
  }
  return total;
}

export async function ultimoReset(): Promise<UltimoReset | null> {
  const r = await consultarUm<UltimoReset>(
    `SELECT executado_em AS "executadoEm", executado_por AS "executadoPor", origem
       FROM infoprice.ctl_reset ORDER BY id DESC LIMIT 1`,
  );
  return r ?? null;
}

export async function existeColetaEmAndamento(): Promise<boolean> {
  const r = await consultarUm<{ existe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM infoprice.ctl_execucao WHERE status = 'em_execucao'
     ) AS existe`,
  );
  return r?.existe ?? false;
}

export interface OpcoesReset {
  executadoPor: string;
  origem: 'console' | 'linha de comando';
  /** Apaga também usuários e sessões: a aplicação volta ao estado de instalação. */
  incluirUsuarios: boolean;
  /** Apaga as cópias locais dos arquivos na área temporária. */
  apagarArquivos: boolean;
}

export interface ResultadoReset {
  apagado: ContagensBase;
  arquivosRemovidos: number;
}

/**
 * Zera a base: todo o histórico de dados e de metadados, numa transação só —
 * ou apaga tudo, ou nada. As partições mensais do fato são removidas (voltam a
 * ser criadas na próxima carga), as sequências recomeçam e o código dos
 * incidentes volta a #201.
 *
 * Quem chama garante que nenhuma coleta está rodando: a rota usa o trilho de
 * coletas do processo, e o comando de terminal pede o servidor parado.
 */
export async function zerarBase(opcoes: OpcoesReset): Promise<ResultadoReset> {
  if (await existeColetaEmAndamento()) {
    throw new Error('já existe uma coleta em andamento · aguarde o término para zerar a base');
  }

  const apagado = await emTransacao(async (cliente) => {
    const antes = await contarBase(cliente);

    const particoes = await cliente.query<{ nome: string }>(
      `SELECT c.relname AS nome
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'infoprice.fact_preco_coletado'::regclass`,
    );
    for (const p of particoes.rows) {
      await cliente.query(`DROP TABLE infoprice.${pg.escapeIdentifier(p.nome)}`);
    }

    await cliente.query(
      `TRUNCATE ${TABELAS_DADOS.map((t) => `infoprice.${t}`).join(', ')} RESTART IDENTITY`,
    );
    await cliente.query('ALTER SEQUENCE infoprice.ctl_incidente_codigo_seq RESTART');

    if (opcoes.incluirUsuarios) {
      // DELETE, e não TRUNCATE: ctl_agendamento referencia o usuário que
      // pausou, e um TRUNCATE ... CASCADE apagaria a linha do agendamento.
      await cliente.query('DELETE FROM infoprice.ctl_sessao');
      await cliente.query('DELETE FROM infoprice.ctl_usuario');
      await cliente.query('ALTER SEQUENCE infoprice.ctl_usuario_id_seq RESTART');
      await cliente.query('ALTER SEQUENCE infoprice.ctl_sessao_id_seq RESTART');
    }

    await cliente.query(
      `INSERT INTO infoprice.ctl_reset
         (executado_por, origem, incluiu_usuarios, apagou_arquivos, contagens)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        opcoes.executadoPor,
        opcoes.origem,
        opcoes.incluirUsuarios,
        opcoes.apagarArquivos,
        JSON.stringify({ ...antes, particoes: particoes.rows.length }),
      ],
    );

    return antes;
  }, { longa: true });

  // Os arquivos saem depois do COMMIT: se a transação falhasse, a base
  // continuaria apontando para cópias que já não existem.
  const arquivosRemovidos = opcoes.apagarArquivos ? await limparAreaTemporaria() : 0;

  return { apagado, arquivosRemovidos };
}

/**
 * Apaga o conteúdo da área temporária (não a pasta em si). Recusa caminhos
 * rasos, como a raiz do disco, para que um AREA_TEMPORARIA mal configurado não
 * vire um desastre.
 */
async function limparAreaTemporaria(): Promise<number> {
  const dir = path.resolve(config.coleta.areaTemporaria);
  const partes = dir.split(path.sep).filter(Boolean);
  if (partes.length < 3) {
    throw new Error(`área temporária ${dir} rasa demais para ser apagada com segurança`);
  }

  let removidos = 0;
  let itens: string[];
  try {
    itens = await fs.readdir(dir);
  } catch {
    return 0; // a pasta ainda não existe
  }
  for (const item of itens) {
    await fs.rm(path.join(dir, item), { recursive: true, force: true });
    removidos += 1;
  }
  return removidos;
}
