import type { NomeEtapa, ProgressoGravacao, SessaoBanco } from '@infoprice/shared';
import { pool } from '../db/pool.js';
import { duracaoBR, numeroBR } from '../util/formato.js';
import type { RegistroExecucao } from './registro-execucao.js';

/**
 * Visibilidade da gravação no banco.
 *
 * A gravação de um arquivo (COPY, partições, gravação no fato em partes)
 * pode levar minutos, e até aqui o log só ganhava uma linha quando ela
 * terminava. Este módulo diz, enquanto ela roda, em que fase está, quantas
 * linhas já foram enviadas e o que o backend do PostgreSQL está fazendo — e,
 * se ele estiver parado esperando um lock, quem o segura.
 *
 * Tudo é gravado pelo pool, fora da transação do arquivo: aparece na tela na
 * hora, e sobrevive ao ROLLBACK para explicar onde a gravação parou.
 */

/** Com que frequência o backend da transação é observado. */
const INTERVALO_VIGIA_MS = 15_000;
/** Uma fase que passa disto sem terminar ganha uma linha no log… */
const FASE_LONGA_MS = 2 * 60_000;
/** …repetida neste intervalo, enquanto ela continuar. */
const REPETIR_AVISO_MS = 2 * 60_000;
/** Contagem de linhas do COPY: gravada no progresso a cada… */
const INTERVALO_PROGRESSO_MS = 5_000;
/** …e registrada no log a cada. */
const INTERVALO_LOG_LINHAS_MS = 60_000;

const CAMPOS_SESSAO = `
  a.pid,
  a.application_name                                              AS aplicacao,
  a.state                                                         AS estado,
  a.wait_event_type                                               AS "esperaTipo",
  a.wait_event                                                    AS espera,
  (EXTRACT(EPOCH FROM (now() - a.query_start)) * 1000)::bigint   AS "consultaHaMs",
  (EXTRACT(EPOCH FROM (now() - a.xact_start)) * 1000)::bigint    AS "transacaoHaMs",
  left(regexp_replace(a.query, '\\s+', ' ', 'g'), 300)            AS consulta`;

/**
 * O backend `pid` em pg_stat_activity e as sessões que o bloqueiam. Nulo se o
 * backend não existe mais (a transação terminou ou a conexão caiu).
 */
export async function retratoBackend(
  pid: number,
): Promise<{ sessao: SessaoBanco; bloqueadores: SessaoBanco[] } | null> {
  const { rows } = await pool.query<SessaoBanco & { bloqueadoPor: number[] }>(
    `SELECT ${CAMPOS_SESSAO}, pg_blocking_pids(a.pid) AS "bloqueadoPor"
       FROM pg_stat_activity a
      WHERE a.pid = $1`,
    [pid],
  );
  const linha = rows[0];
  if (!linha) return null;

  const { bloqueadoPor, ...sessao } = linha;
  let bloqueadores: SessaoBanco[] = [];
  if (bloqueadoPor && bloqueadoPor.length > 0) {
    const r = await pool.query<SessaoBanco>(
      `SELECT ${CAMPOS_SESSAO}
         FROM pg_stat_activity a
        WHERE a.pid = ANY($1::int[])
        ORDER BY a.xact_start NULLS LAST`,
      [bloqueadoPor],
    );
    bloqueadores = r.rows;
    // Um bloqueador que já não aparece (terminou entre as duas consultas)
    // ainda é mostrado pelo pid.
    for (const p of bloqueadoPor) {
      if (!bloqueadores.some((b) => b.pid === p)) {
        bloqueadores.push({
          pid: p,
          aplicacao: null,
          estado: null,
          esperaTipo: null,
          espera: null,
          consultaHaMs: null,
          transacaoHaMs: null,
          consulta: null,
        });
      }
    }
  }
  return { sessao, bloqueadores };
}

/**
 * O retrato de um arquivo gravado por vários backends ao mesmo tempo: a sessão
 * mostrada é a que está bloqueada (se houver), e os bloqueadores são a soma
 * dos de todas.
 */
export async function retratoDosBackends(
  pids: number[],
): Promise<{ sessao: SessaoBanco; bloqueadores: SessaoBanco[] } | null> {
  const retratos = (await Promise.all(pids.map((p) => retratoBackend(p)))).filter(
    (r): r is NonNullable<typeof r> => r !== null,
  );
  if (retratos.length === 0) return null;
  const bloqueadores = new Map<number, SessaoBanco>();
  for (const r of retratos) for (const b of r.bloqueadores) bloqueadores.set(b.pid, b);
  const principal = retratos.find((r) => r.bloqueadores.length > 0) ?? retratos[0]!;
  return { sessao: principal.sessao, bloqueadores: [...bloqueadores.values()] };
}

/** "Lock:transactionid", "IO:DataFileRead"… ou o estado, quando não espera. */
export function descreverEspera(s: SessaoBanco): string {
  if (s.esperaTipo) return `${s.esperaTipo}:${s.espera ?? '?'}`;
  return s.estado === 'active' ? 'executando (CPU)' : (s.estado ?? 'sem estado');
}

/** Uma linha sobre quem segura o lock, com o comando para liberá-lo. */
export function descreverBloqueador(b: SessaoBanco): string {
  const partes = [`pid ${b.pid}`];
  if (b.aplicacao) partes.push(b.aplicacao);
  if (b.estado) partes.push(b.estado);
  if (b.transacaoHaMs !== null) partes.push(`transação aberta há ${duracaoBR(b.transacaoHaMs)}`);
  if (b.consulta) partes.push(`última consulta: ${b.consulta.slice(0, 160)}`);
  return partes.join(' · ');
}

/** As fases da transação de um arquivo, na ordem em que rodam. */
export type Fase = 'COPY → tabela de carga' | 'partições' | 'gravação → fact_preco_coletado';

/** Em que etapa do painel cada fase da gravação se encaixa. */
function etapaDaFase(fase: Fase): NomeEtapa {
  return fase === 'COPY → tabela de carga' ? 'Carga em staging' : 'Merge incremental';
}

/**
 * Acompanha a gravação de um arquivo, do início da transação ao COMMIT.
 *
 * As gravações no banco passam por uma fila: a do vigia (timer) e as das fases
 * nunca se atropelam, e o progresso nunca volta para um retrato mais velho.
 */
export class AcompanhamentoArquivo {
  private progresso: ProgressoGravacao;
  private fila: Promise<void> = Promise.resolve();
  private vigia: NodeJS.Timeout | null = null;
  private faseAtual: Fase | null = null;
  private inicioFase = Date.now();
  private readonly inicioArquivo = Date.now();
  private ultimaGravacaoLinhas = 0;
  private ultimoLogLinhas = Date.now();
  private ultimoAviso = 0;
  private ultimosBloqueadores = '';
  private readonly duracoes = new Map<Fase, number>();
  /** Backends com transação deste arquivo em curso. */
  private readonly pids = new Set<number>();
  private readonly prefixo: string;

  constructor(
    private readonly registro: RegistroExecucao,
    arquivo: { posicao: number; total: number; idArquivo: number; nome: string },
  ) {
    const agora = new Date().toISOString();
    this.prefixo = `[${arquivo.posicao}/${arquivo.total}] ${arquivo.nome}`;
    this.progresso = {
      posicao: arquivo.posicao,
      total: arquivo.total,
      idArquivo: arquivo.idArquivo,
      arquivo: arquivo.nome,
      fase: 'aguardando conexão com o banco',
      faseDesde: agora,
      arquivoDesde: agora,
      linhasLidas: 0,
      pid: null,
      pids: [],
      atualizadoEm: agora,
      banco: null,
      bloqueadores: [],
    };
  }

  /** Grava o progresso já, antes mesmo da transação abrir. */
  async iniciar(): Promise<void> {
    await this.persistir();
  }

  /**
   * Uma transação do arquivo abriu no backend `pid`: registra e passa a
   * observá-lo. O nome da aplicação fica com a execução, o arquivo e a parte,
   * para quem olhar pg_stat_activity direto no banco saber de quem é cada
   * sessão.
   */
  async vincular(
    cliente: { query: (sql: string, v?: unknown[]) => Promise<unknown> },
    pid: number,
    rotulo: string,
  ): Promise<void> {
    await cliente.query(`SELECT set_config('application_name', $1, true)`, [
      `ingestao exec#${this.registro.id} arq#${this.progresso.idArquivo} ${rotulo}`,
    ]);
    this.pids.add(pid);
    this.atualizarPids();
    await this.persistir();

    if (!this.vigia) {
      this.vigia = setInterval(() => void this.observar(), INTERVALO_VIGIA_MS);
      this.vigia.unref();
    }
  }

  /** A transação do backend `pid` terminou. */
  desvincular(pid: number): void {
    this.pids.delete(pid);
    this.atualizarPids();
  }

  private atualizarPids(): void {
    this.progresso.pids = [...this.pids];
    this.progresso.pid = this.progresso.pids[0] ?? null;
  }

  /**
   * Muda de fase. A linha do log fecha a fase anterior com a duração dela e
   * diz qual começa — é o que mostra, depois, onde o tempo foi gasto.
   */
  async fase(nova: Fase, complemento?: string): Promise<void> {
    const agora = Date.now();
    const anterior = this.faseAtual;
    const msAnterior = agora - this.inicioFase;
    if (anterior) this.duracoes.set(anterior, msAnterior);
    this.faseAtual = nova;
    this.inicioFase = agora;
    this.ultimoAviso = 0;

    const fechou = anterior ? `${anterior} em ${duracaoBR(msAnterior)}` : null;
    await this.registro.info(
      `${this.prefixo} · ` +
        (fechou ? `${fechou} → ` : '') +
        nova +
        (complemento ? ` · ${complemento}` : ''),
    );

    this.progresso.fase = complemento ? `${nova} · ${complemento}` : nova;
    this.progresso.faseDesde = new Date(agora).toISOString();
    await this.persistir();
    await this.registro.detalharEtapa(
      etapaDaFase(nova),
      `${this.prefixo} · ${this.progresso.fase}`,
    );
  }

  /** Subfase dentro da fase corrente (a regra em curso, por exemplo). */
  async detalhe(texto: string): Promise<void> {
    if (!this.faseAtual) return;
    this.progresso.fase = `${this.faseAtual} · ${texto}`;
    await this.persistir();
  }

  /** Linhas enviadas ao COPY até agora; grava e registra com moderação. */
  async linhas(total: number): Promise<void> {
    this.progresso.linhasLidas = total;
    const agora = Date.now();
    if (agora - this.ultimaGravacaoLinhas >= INTERVALO_PROGRESSO_MS) {
      this.ultimaGravacaoLinhas = agora;
      await this.persistir();
    }
    if (agora - this.ultimoLogLinhas >= INTERVALO_LOG_LINHAS_MS) {
      this.ultimoLogLinhas = agora;
      const seg = Math.max(1, (agora - this.inicioFase) / 1000);
      await this.registro.info(
        `${this.prefixo} · COPY em andamento · ${numeroBR(total)} linhas enviadas ` +
          `em ${duracaoBR(agora - this.inicioFase)} · ${numeroBR(Math.round(total / seg))} linhas/s`,
      );
    }
  }

  /** "COPY 1s · partições 1s · gravação 9s" — onde o tempo do arquivo foi. */
  tempos(): string {
    if (this.faseAtual) this.duracoes.set(this.faseAtual, Date.now() - this.inicioFase);
    return [...this.duracoes]
      .map(([fase, ms]) => `${fase.split(' ')[0]} ${duracaoBR(ms)}`)
      .join(' · ');
  }

  /** Para o vigia. `fechamento` é o último estado gravado no progresso. */
  async encerrar(fechamento: string): Promise<void> {
    if (this.vigia) clearInterval(this.vigia);
    this.vigia = null;
    await this.fila;
    const ms = Date.now() - this.inicioArquivo;
    this.progresso.fase = `${fechamento} · ${duracaoBR(ms)} no arquivo`;
    this.progresso.faseDesde = new Date().toISOString();
    this.pids.clear();
    this.atualizarPids();
    this.progresso.banco = null;
    this.progresso.bloqueadores = [];
    await this.persistir();
  }

  /** O vigia: um retrato dos backends a cada INTERVALO_VIGIA_MS. */
  private async observar(): Promise<void> {
    if (this.pids.size === 0) return;
    try {
      const retrato = await retratoDosBackends([...this.pids]);
      if (!retrato || this.pids.size === 0) return;
      this.progresso.banco = retrato.sessao;
      this.progresso.bloqueadores = retrato.bloqueadores;
      await this.persistir();

      const agora = Date.now();
      const naFase = agora - this.inicioFase;
      const s = retrato.sessao;

      if (retrato.bloqueadores.length > 0) {
        // Bloqueio: avisa assim que aparece, e de novo se quem bloqueia
        // mudar ou se continuar parado.
        const chave = retrato.bloqueadores.map((b) => b.pid).sort().join(',');
        if (chave !== this.ultimosBloqueadores || agora - this.ultimoAviso >= REPETIR_AVISO_MS) {
          this.ultimosBloqueadores = chave;
          this.ultimoAviso = agora;
          const lista = retrato.bloqueadores.map(descreverBloqueador).join(' | ');
          const liberar = retrato.bloqueadores
            .map((b) => `SELECT pg_terminate_backend(${b.pid});`)
            .join(' ');
          await this.registro.warn(
            `${this.prefixo} · ${this.faseAtual ?? 'gravação'} parada há ${duracaoBR(s.consultaHaMs ?? naFase)} ` +
              `esperando lock (${descreverEspera(s)}) · bloqueada por ${lista} · ` +
              `se a sessão for de uma coleta antiga, libere com: ${liberar}`,
          );
        }
        return;
      }
      this.ultimosBloqueadores = '';

      if (naFase >= FASE_LONGA_MS && agora - this.ultimoAviso >= REPETIR_AVISO_MS) {
        this.ultimoAviso = agora;
        const ocioso = s.estado === 'idle in transaction';
        await this.registro.log(
          ocioso ? 'WARN' : 'INFO',
          `${this.prefixo} · ${this.faseAtual ?? 'gravação'} há ${duracaoBR(naFase)} · ` +
            `backend pid ${s.pid} ${descreverEspera(s)}` +
            (this.faseAtual === 'COPY → tabela de carga'
              ? ` · ${numeroBR(this.progresso.linhasLidas)} linhas enviadas`
              : '') +
            (ocioso
              ? ' · o banco está esperando o processo da coleta, e não o contrário'
              : ' · o banco segue trabalhando'),
        );
      }
    } catch (erro) {
      // O vigia nunca derruba a coleta: se a observação falhar, a gravação
      // segue e a próxima volta tenta de novo.
      console.warn(
        `[exec ${this.registro.id}] vigia do banco:`,
        erro instanceof Error ? erro.message : erro,
      );
    }
  }

  private persistir(): Promise<void> {
    const proxima = this.fila.then(async () => {
      this.progresso.atualizadoEm = new Date().toISOString();
      // Um objeto por arquivo, chaveado pelo id: com a gravação em paralelo,
      // cada arquivo atualiza só a própria entrada, e o merge no banco é
      // atômico — um não apaga o progresso do outro. (O formato antigo, um
      // objeto só com `posicao`, é substituído na primeira gravação.)
      await pool
        .query(
          `UPDATE infoprice.ctl_execucao
              SET progresso = CASE
                    WHEN jsonb_typeof(progresso) = 'object' AND NOT progresso ? 'posicao'
                      THEN progresso
                    ELSE '{}'::jsonb
                  END || jsonb_build_object($2::text, $3::jsonb)
            WHERE id = $1`,
          [this.registro.id, String(this.progresso.idArquivo), JSON.stringify(this.progresso)],
        )
        .catch((erro: unknown) => {
          console.warn(
            `[exec ${this.registro.id}] progresso:`,
            erro instanceof Error ? erro.message : erro,
          );
        });
    });
    this.fila = proxima;
    return proxima;
  }
}
