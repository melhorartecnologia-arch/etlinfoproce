import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;

// numeric chega como string por padrão (para não perder precisão) — mantemos
// assim de propósito: preço é dinheiro e vai para a tela já formatado.
// date (OID 1082) vira 'YYYY-MM-DD' em vez de um Date no fuso do processo,
// que deslocaria o dia em servidores fora de America/Sao_Paulo.
types.setTypeParser(1082, (v) => v);

// bigint (OID 20) volta como string; as contagens aqui cabem folgadamente em
// Number, então convertemos para evitar '4812339' escapando para o JSON.
types.setTypeParser(20, (v) => Number(v));

export const pool = new Pool({
  host: config.banco.host,
  port: config.banco.porta,
  database: config.banco.banco,
  user: config.banco.usuario,
  password: config.banco.senha,
  max: config.banco.maxConexoes,
  application_name: 'console-ingestao-infoprice',
});

pool.on('error', (erro) => {
  console.error('[pg] erro em conexão ociosa:', erro.message);
});

export type Cliente = pg.PoolClient;

/** Executa uma consulta no pool. */
export async function consultar<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  valores: unknown[] = [],
): Promise<T[]> {
  const r = await pool.query<T>(sql, valores);
  return r.rows;
}

/** Primeira linha da consulta, ou null. */
export async function consultarUm<
  T extends pg.QueryResultRow = pg.QueryResultRow,
>(sql: string, valores: unknown[] = []): Promise<T | null> {
  const linhas = await consultar<T>(sql, valores);
  return linhas[0] ?? null;
}

/**
 * Roda o callback dentro de uma transação. Qualquer erro dispara ROLLBACK —
 * é o que garante a promessa de "rollback total em qualquer falha" da tela de
 * idempotência.
 */
export async function emTransacao<T>(
  fn: (cliente: Cliente) => Promise<T>,
): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await fn(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (erro) {
    try {
      await cliente.query('ROLLBACK');
    } catch {
      // a conexão já pode ter caído; o erro original é o que importa
    }
    throw erro;
  } finally {
    cliente.release();
  }
}

export async function fecharPool(): Promise<void> {
  await pool.end();
}
