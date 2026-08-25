import cron, { type ScheduledTask } from 'node-cron';
import parser from 'cron-parser';
import { config } from '../config.js';
import { consultar, consultarUm, pool } from '../db/pool.js';
import { executarColeta } from '../ingest/pipeline.js';
import {
  enviarResumoDiario,
  verificarExpiracao,
  verificarPastaAusente,
} from '../alertas/index.js';
import { dataLocal, esperar, passouDe } from '../util/tempo.js';

/** Uma coleta por vez: o agendador, a varredura e a tela compartilham este trilho. */
let emAndamento: Promise<unknown> | null = null;

export function coletaEmAndamento(): boolean {
  return emAndamento !== null;
}

/**
 * Serializa as coletas. Se já houver uma rodando, a nova é recusada — é melhor
 * dizer "já tem uma execução em andamento" do que disputar o mesmo staging.
 */
export async function comTrilho<T>(fn: () => Promise<T>): Promise<T> {
  if (emAndamento) {
    throw new Error('já existe uma coleta em andamento');
  }
  const tarefa = fn();
  emAndamento = tarefa;
  try {
    return await tarefa;
  } finally {
    emAndamento = null;
  }
}

async function estaPausado(): Promise<boolean> {
  const linha = await consultarUm<{ pausado: boolean }>(
    'SELECT pausado FROM infoprice.ctl_agendamento WHERE id = 1',
  );
  return linha?.pausado ?? false;
}

/**
 * A coleta do dia, com as tentativas previstas na configuração.
 *
 * Entre uma tentativa e outra o processo espera 10, 20 e 40 minutos. Se todas
 * falharem, o incidente crítico já terá sido aberto pelo módulo de alertas na
 * última tentativa.
 */
export async function coletaDiariaComTentativas(
  runDate = dataLocal(),
  gatilho: 'agendador' | 'manual' | 'varredura' = 'agendador',
): Promise<void> {
  const maximo = Math.max(1, config.agendamento.tentativas);

  for (let tentativa = 1; tentativa <= maximo; tentativa += 1) {
    const resultado = await executarColeta({
      runDate,
      gatilho: tentativa === 1 ? gatilho : 'retentativa',
      tentativa,
    });

    if (resultado.status !== 'falha') return;

    if (tentativa < maximo) {
      const esperaMin =
        config.agendamento.esperasMin[tentativa - 1] ?? 10;
      console.warn(
        `[agendador] tentativa ${tentativa}/${maximo} falhou · nova tentativa em ${esperaMin} min`,
      );
      await esperar(esperaMin * 60_000);

      // O operador pode ter pausado o agendamento durante a espera.
      if (await estaPausado()) {
        console.warn('[agendador] agendamento pausado · tentativas encerradas');
        return;
      }
    } else {
      console.error(
        `[agendador] as ${maximo} tentativas de run=${runDate} falharam`,
      );
    }
  }
}

/**
 * Varredura de segurança das 12:00 e 18:00.
 *
 * Procura pastas que apareceram na origem e ainda não foram ingeridas — o caso
 * do fornecedor que publica atrasado — e verifica a janela de tolerância e a
 * expiração dos arquivos.
 */
export async function varredura(): Promise<void> {
  const hoje = dataLocal();

  if (await estaPausado()) {
    console.log('[varredura] agendamento pausado · nada a fazer');
    return;
  }

  // A pasta do dia chegou?
  const doDia = await consultarUm<{ total: number }>(
    `SELECT count(*)::bigint AS total
       FROM infoprice.ctl_execucao
      WHERE run_date = $1 AND status IN ('concluida', 'parcial')`,
    [hoje],
  );

  if ((doDia?.total ?? 0) === 0) {
    if (passouDe(config.agendamento.toleranciaAte)) {
      await verificarPastaAusente(hoje);
    }
    console.log('[varredura] tentando a coleta do dia');
    await comTrilho(() => coletaDiariaComTentativas(hoje, 'varredura')).catch(
      (erro) => console.error('[varredura]', erro.message),
    );
  }

  // Pastas vistas na origem sem ingestão concluída, dentro da retenção.
  const pendentes = await consultar<{ run_date: string }>(
    `SELECT DISTINCT a.run_date
       FROM infoprice.ctl_arquivo a
      WHERE a.status IN ('visto', 'baixado', 'erro')
        AND a.run_date >= current_date - $1::integer
        AND a.run_date <> $2::date
      ORDER BY a.run_date`,
    [config.coleta.retencaoOrigemDias, hoje],
  );

  for (const p of pendentes) {
    console.log(`[varredura] retomando run=${p.run_date}`);
    await comTrilho(() =>
      executarColeta({ runDate: p.run_date, gatilho: 'varredura' }),
    ).catch((erro) => console.error('[varredura]', erro.message));
  }

  await verificarExpiracao();
}

/** Próxima execução prevista, considerando pausa e fuso. */
export async function proximaExecucao(): Promise<string | null> {
  if (await estaPausado()) return null;

  const linha = await consultarUm<{ cron: string; timezone: string }>(
    'SELECT cron, timezone FROM infoprice.ctl_agendamento WHERE id = 1',
  );

  try {
    const intervalo = parser.parseExpression(
      linha?.cron ?? config.agendamento.cronColeta,
      { tz: linha?.timezone ?? config.agendamento.timezone },
    );
    return intervalo.next().toDate().toISOString();
  } catch {
    return null;
  }
}

export async function pausarAgendamento(quem: string): Promise<void> {
  await pool.query(
    `UPDATE infoprice.ctl_agendamento
        SET pausado = true, pausado_em = now(), pausado_por = $1
      WHERE id = 1`,
    [quem],
  );
}

export async function retomarAgendamento(): Promise<void> {
  await pool.query(
    `UPDATE infoprice.ctl_agendamento
        SET pausado = false, pausado_em = NULL, pausado_por = NULL
      WHERE id = 1`,
  );
}

const tarefas: ScheduledTask[] = [];

/** Registra as três rotinas: coleta, varredura e resumo diário. */
export function iniciarAgendador(): void {
  if (!config.agendamento.ativo) {
    console.log('[agendador] desativado por configuração (AGENDAMENTO_ATIVO)');
    return;
  }

  const opcoes = { timezone: config.agendamento.timezone };

  tarefas.push(
    cron.schedule(
      config.agendamento.cronColeta,
      async () => {
        if (await estaPausado()) {
          console.log('[agendador] pausado · coleta do dia não será disparada');
          return;
        }
        console.log('[agendador] disparando a coleta do dia');
        await comTrilho(() => coletaDiariaComTentativas()).catch((erro) =>
          console.error('[agendador]', erro.message),
        );
      },
      opcoes,
    ),
  );

  tarefas.push(
    cron.schedule(
      config.agendamento.cronVarredura,
      () => {
        console.log('[agendador] varredura de segurança');
        varredura().catch((erro) => console.error('[varredura]', erro.message));
      },
      opcoes,
    ),
  );

  tarefas.push(
    cron.schedule(
      config.agendamento.cronResumo,
      () => {
        enviarResumoDiario().catch((erro) =>
          console.error('[resumo]', erro.message),
        );
      },
      opcoes,
    ),
  );

  console.log(
    `[agendador] coleta ${config.agendamento.cronColeta} · ` +
      `varredura ${config.agendamento.cronVarredura} · ` +
      `resumo ${config.agendamento.cronResumo} · ${config.agendamento.timezone}`,
  );
}

export function pararAgendador(): void {
  for (const t of tarefas) t.stop();
  tarefas.length = 0;
}
