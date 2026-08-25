import pg from 'pg';
import { config } from '../config.js';
import { obterSenha } from './credenciais.js';
import { opcoesTls } from './tls.js';

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
  // O usuário sempre vem do ambiente: nome de login não é segredo, e mantê-lo
  // aqui evita ter de resolver o cofre antes de montar o pool.
  user: config.banco.usuario,
  // Função, e não valor: com autenticação IAM a "senha" é um token de 15
  // minutos, gerado a cada conexão nova.
  password: obterSenha,
  max: config.banco.maxConexoes,
  application_name: 'console-ingestao-infoprice',

  // O search_path vai nos parâmetros de inicialização da conexão, e não numa
  // consulta depois do connect: assim ele já vale na primeira consulta, sem
  // corrida entre o SET e o que o chamador vai executar. Também evita depender
  // do padrão do usuário do banco, que no RDS não é o mesmo de uma instalação
  // feita à mão.
  options: `-c search_path=${config.banco.schema},public`,

  ssl: opcoesTls(),

  // ── Tempos ────────────────────────────────────────────────────────────────
  // Contra um banco na mesma máquina os padrões do driver bastam. Contra o RDS
  // há um salto de rede no caminho, e um socket pendurado sem limite é o que
  // transforma uma indisponibilidade curta do banco em travamento da aplicação.
  connectionTimeoutMillis: config.banco.timeoutConexaoMs,
  idleTimeoutMillis: config.banco.timeoutOciosaMs,
  statement_timeout: config.banco.timeoutConsultaMs,
  idle_in_transaction_session_timeout: config.banco.timeoutTransacaoOciosaMs,

  // Detecta o socket morto que sobra depois de um failover Multi-AZ: sem
  // keepalive, a conexão só falharia na próxima consulta, que ficaria esperando
  // até o timeout do sistema operacional.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

/**
 * Erros em conexões ociosas são normais contra o RDS: um failover, uma janela
 * de manutenção ou o encerramento de conexões pelo servidor derrubam o que
 * estava no pool. O `pg` descarta a conexão quebrada sozinho e abre outra na
 * próxima consulta — o que não pode acontecer é o evento subir como
 * unhandled e derrubar o processo.
 */
pool.on('error', (erro) => {
  console.error('[pg] conexão ociosa caiu:', erro.message);
});

let conexoesAbertas = 0;

pool.on('connect', () => {
  conexoesAbertas += 1;
});

/** Diagnóstico para o health check. */
export function estadoPool() {
  return {
    total: pool.totalCount,
    ociosas: pool.idleCount,
    esperando: pool.waitingCount,
    abertasNoProcesso: conexoesAbertas,
  };
}

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
  opcoes: { longa?: boolean } = {},
): Promise<T> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    // O COPY de milhões de linhas e o merge passam bem dos 30 segundos que
    // valem para uma consulta de tela. `longa` levanta o teto só nesta
    // transação; a conexão volta ao pool com o padrão restaurado no COMMIT.
    if (opcoes.longa) {
      await cliente.query(
        `SET LOCAL statement_timeout = ${config.banco.timeoutIngestaoMs}`,
      );
      await cliente.query(
        `SET LOCAL idle_in_transaction_session_timeout = ${config.banco.timeoutTransacaoOciosaMs}`,
      );
    }

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
