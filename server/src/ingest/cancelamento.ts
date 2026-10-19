import { consultarUm, pool } from '../db/pool.js';

/**
 * Parar uma coleta em andamento.
 *
 * O pedido fica gravado em ctl_execucao (alcança outro processo, como o
 * `ingest` no terminal) e, quando a coleta roda neste processo, também aborta
 * na hora: o sinal interrompe a leitura do arquivo e a consulta SQL em curso
 * é cancelada no PostgreSQL. Em todo caso a coleta para num ponto seguro — o
 * arquivo em curso é revertido, os já gravados ficam.
 */

/** A coleta grava o batimento neste intervalo… */
export const INTERVALO_BATIMENTO_MS = 30_000;
/** …e sem batimento por este tempo ela é considerada sem processo (órfã). */
const LIMITE_ORFA = '2 minutes';
/** Com que frequência a coleta consulta o banco atrás de um pedido de parada. */
const INTERVALO_CONSULTA_MS = 3_000;

export class ExecucaoCancelada extends Error {
  constructor(readonly motivo: string) {
    super(`execução cancelada · ${motivo}`);
    this.name = 'ExecucaoCancelada';
  }
}

interface Ativa {
  controle: AbortController;
  motivo: string;
  /** Backends do PostgreSQL com consulta desta coleta em curso. */
  pids: Set<number>;
  ultimaConsulta: number;
  terminou: Promise<void>;
  aoTerminar: () => void;
}

const ativas = new Map<number, Ativa>();

export interface ControleCancelamento {
  sinal: AbortSignal;
  /** Lança ExecucaoCancelada se a parada foi pedida (aqui ou pelo banco). */
  verificar: () => Promise<void>;
  /** Registra o backend de uma transação, para que a parada a interrompa. */
  comPid: <T>(pid: number, fn: () => Promise<T>) => Promise<T>;
  liberar: () => void;
}

/** Abre o controle de parada de uma coleta deste processo. */
export function registrarExecucao(idExecucao: number): ControleCancelamento {
  let aoTerminar = () => {};
  const terminou = new Promise<void>((r) => (aoTerminar = r));
  const ativa: Ativa = {
    controle: new AbortController(),
    motivo: '',
    pids: new Set(),
    ultimaConsulta: Date.now(),
    terminou,
    aoTerminar,
  };
  ativas.set(idExecucao, ativa);

  const verificar = async () => {
    if (!ativa.controle.signal.aborted && Date.now() - ativa.ultimaConsulta >= INTERVALO_CONSULTA_MS) {
      ativa.ultimaConsulta = Date.now();
      const r = await consultarUm<{ cancelado_por: string | null; pedido: boolean }>(
        `SELECT cancelado_por, cancelamento_solicitado_em IS NOT NULL AS pedido
           FROM infoprice.ctl_execucao WHERE id = $1`,
        [idExecucao],
      );
      if (r?.pedido) {
        ativa.motivo = `parada pedida por ${r.cancelado_por ?? 'outro processo'}`;
        ativa.controle.abort();
      }
    }
    if (ativa.controle.signal.aborted) {
      throw new ExecucaoCancelada(ativa.motivo || 'parada pedida');
    }
  };

  return {
    sinal: ativa.controle.signal,
    verificar,
    comPid: async (pid, fn) => {
      ativa.pids.add(pid);
      try {
        return await fn();
      } finally {
        ativa.pids.delete(pid);
      }
    },
    liberar: () => {
      ativas.delete(idExecucao);
      ativa.aoTerminar();
    },
  };
}

/** Aborta uma coleta deste processo. Devolve false se ela não roda aqui. */
export function cancelarLocal(idExecucao: number, motivo: string): boolean {
  const ativa = ativas.get(idExecucao);
  if (!ativa) return false;
  if (!ativa.controle.signal.aborted) {
    ativa.motivo = motivo;
    ativa.controle.abort();
    // A consulta em curso (COPY, regras, merge) é interrompida no banco; a
    // transação do arquivo cai e é revertida.
    for (const pid of ativa.pids) {
      pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => undefined);
    }
  }
  return true;
}

/**
 * Para todas as coletas deste processo e espera que encerrem, até `limiteMs`.
 * Usado no desligamento do servidor e no Ctrl+C do terminal, para que a
 * execução termine como cancelada em vez de virar órfã.
 */
export async function cancelarTodasLocais(motivo: string, limiteMs = 15_000): Promise<void> {
  const pendentes = [...ativas.entries()].map(([id, a]) => {
    cancelarLocal(id, motivo);
    return a.terminou;
  });
  if (pendentes.length === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(pendentes),
    new Promise((r) => (timer = setTimeout(r, limiteMs))),
  ]);
  // Sem isto o temporizador seguraria o processo vivo até o limite, mesmo com
  // a coleta já encerrada.
  clearTimeout(timer);
}

export type ResultadoPedido = 'parando' | 'encerrada' | 'pedida' | 'nao_esta_em_andamento';

/**
 * Pede a parada de uma execução.
 *
 * - roda neste processo: aborta na hora → 'parando'
 * - sem batimento recente (processo morto): encerra já no banco → 'encerrada'
 * - viva em outro processo: fica o pedido, que ela lê em segundos → 'pedida'
 */
export async function pedirCancelamento(idExecucao: number, quem: string): Promise<ResultadoPedido> {
  const linha = await consultarUm<{ orfa: boolean }>(
    `UPDATE infoprice.ctl_execucao
        SET cancelamento_solicitado_em = COALESCE(cancelamento_solicitado_em, now()),
            cancelado_por = COALESCE(cancelado_por, $2)
      WHERE id = $1 AND status = 'em_execucao'
      RETURNING COALESCE(batimento_em, iniciado_em) < now() - INTERVAL '${LIMITE_ORFA}' AS orfa`,
    [idExecucao, quem],
  );
  if (!linha) return 'nao_esta_em_andamento';

  if (cancelarLocal(idExecucao, `parada pedida por ${quem}`)) return 'parando';

  if (linha.orfa) {
    await encerrarOrfa(idExecucao, `encerrada por ${quem}: nenhum processo ativo executava esta coleta`);
    return 'encerrada';
  }
  return 'pedida';
}

/**
 * Encerra no banco as execuções órfãs: em_execucao, fora deste processo e sem
 * batimento recente. Roda na subida do servidor — o que ficou em andamento de
 * antes de um reinício não tem mais quem o termine.
 */
export async function encerrarOrfas(): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM infoprice.ctl_execucao
      WHERE status = 'em_execucao'
        AND COALESCE(batimento_em, iniciado_em) < now() - INTERVAL '${LIMITE_ORFA}'`,
  );
  let encerradas = 0;
  for (const { id } of rows) {
    if (ativas.has(id)) continue;
    await encerrarOrfa(id, 'interrompida: o processo que executava esta coleta parou (servidor reiniciado ou terminal fechado)');
    encerradas += 1;
  }
  return encerradas;
}

async function encerrarOrfa(idExecucao: number, motivo: string): Promise<void> {
  await pool.query(
    `UPDATE infoprice.ctl_execucao
        SET status = 'cancelada', finalizado_em = now(), erro = $2
      WHERE id = $1 AND status = 'em_execucao'`,
    [idExecucao, motivo],
  );
  await pool.query(
    `UPDATE infoprice.ctl_execucao_etapa
        SET status = CASE WHEN status = 'em_curso' THEN 'erro' ELSE 'ignorada' END,
            detalhe = CASE WHEN status = 'em_curso' THEN 'interrompida' ELSE COALESCE(detalhe, 'não executada') END,
            finalizado_em = COALESCE(finalizado_em, now())
      WHERE id_execucao = $1 AND status IN ('em_curso', 'pendente')`,
    [idExecucao],
  );
  await pool.query(
    `INSERT INTO infoprice.ctl_execucao_log (id_execucao, nivel, mensagem) VALUES ($1, 'WARN', $2)`,
    [idExecucao, motivo],
  );
}

/** Mantém o batimento da execução enquanto ela roda. */
export function manterBatimento(idExecucao: number): () => void {
  const bater = () =>
    pool
      .query('UPDATE infoprice.ctl_execucao SET batimento_em = now() WHERE id = $1', [idExecucao])
      .catch(() => undefined);
  void bater();
  const timer = setInterval(bater, INTERVALO_BATIMENTO_MS);
  timer.unref();
  return () => clearInterval(timer);
}
