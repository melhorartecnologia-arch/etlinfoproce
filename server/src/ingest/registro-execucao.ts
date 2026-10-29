import crypto from 'node:crypto';
import { ETAPAS_PROCESSO } from '@infoprice/shared';
import type { NivelLog, NomeEtapa } from '@infoprice/shared';
import { consultarUm, pool } from '../db/pool.js';
import { encerrarOrfas } from './cancelamento.js';

/**
 * Escreve a trilha de auditoria de uma execução: a linha em ctl_execucao, as
 * 10 etapas e cada evento do log.
 *
 * A gravação acontece fora da transação de dados de propósito — se o merge for
 * revertido, o log do que aconteceu precisa sobreviver para explicar o motivo.
 */
export class RegistroExecucao {
  private constructor(
    readonly id: number,
    readonly runDate: string,
    readonly assinatura: string,
  ) {}

  static async abrir(opcoes: {
    runDate: string;
    tipo?: string;
    gatilho?: string;
    tentativa?: number;
    fonte?: string;
    idUsuario?: number;
  }): Promise<RegistroExecucao> {
    const assinatura = crypto.randomBytes(4).toString('hex');

    // Uma execução órfã ocuparia o índice de "uma em andamento por vez" e
    // faria esta inserção falhar para sempre.
    await encerrarOrfas();

    const linha = await consultarUm<{ id: number }>(
      `INSERT INTO infoprice.ctl_execucao
         (run_date, tipo, gatilho, assinatura, fonte, tentativa, status, id_usuario, batimento_em)
       VALUES ($1, $2, $3, $4, $5, $6, 'em_execucao', $7, now())
       RETURNING id`,
      [
        opcoes.runDate,
        opcoes.tipo ?? 'incremental',
        opcoes.gatilho ?? 'agendador',
        assinatura,
        opcoes.fonte ?? 'ISA-InfoPanel',
        opcoes.tentativa ?? 1,
        opcoes.idUsuario ?? null,
      ],
    );

    if (!linha) throw new Error('não foi possível abrir a execução');

    const registro = new RegistroExecucao(linha.id, opcoes.runDate, assinatura);
    await registro.criarEtapas();
    return registro;
  }

  private async criarEtapas(): Promise<void> {
    const valores: unknown[] = [];
    const trechos: string[] = [];
    ETAPAS_PROCESSO.forEach((nome, i) => {
      const base = i * 3;
      trechos.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      valores.push(this.id, i + 1, nome);
    });

    await pool.query(
      `INSERT INTO infoprice.ctl_execucao_etapa (id_execucao, ordem, nome)
       VALUES ${trechos.join(', ')}`,
      valores,
    );
  }

  /** Grava um evento no log técnico. */
  async log(nivel: NivelLog, mensagem: string): Promise<void> {
    await pool.query(
      `INSERT INTO infoprice.ctl_execucao_log (id_execucao, nivel, mensagem)
       VALUES ($1, $2, $3)`,
      [this.id, nivel, mensagem],
    );
    const prefixo = `[exec ${this.id}] ${nivel.padEnd(4)}`;
    if (nivel === 'ERRO') console.error(prefixo, mensagem);
    else if (nivel === 'WARN') console.warn(prefixo, mensagem);
    else console.log(prefixo, mensagem);
  }

  info(msg: string) { return this.log('INFO', msg); }
  warn(msg: string) { return this.log('WARN', msg); }
  erro(msg: string) { return this.log('ERRO', msg); }

  private ordemDe(nome: NomeEtapa): number {
    return ETAPAS_PROCESSO.indexOf(nome) + 1;
  }

  async iniciarEtapa(nome: NomeEtapa): Promise<void> {
    await pool.query(
      `UPDATE infoprice.ctl_execucao_etapa
          SET status = 'em_curso', iniciado_em = now()
        WHERE id_execucao = $1 AND ordem = $2`,
      [this.id, this.ordemDe(nome)],
    );
  }

  async concluirEtapa(nome: NomeEtapa, detalhe: string): Promise<void> {
    await pool.query(
      `UPDATE infoprice.ctl_execucao_etapa
          SET status = 'ok',
              detalhe = $3,
              finalizado_em = now(),
              duracao_ms = GREATEST(
                0,
                (EXTRACT(EPOCH FROM (now() - COALESCE(iniciado_em, now()))) * 1000)::integer
              )
        WHERE id_execucao = $1 AND ordem = $2`,
      [this.id, this.ordemDe(nome), detalhe],
    );
  }

  async falharEtapa(nome: NomeEtapa, detalhe: string): Promise<void> {
    await pool.query(
      `UPDATE infoprice.ctl_execucao_etapa
          SET status = 'erro',
              detalhe = $3,
              finalizado_em = now(),
              duracao_ms = GREATEST(
                0,
                (EXTRACT(EPOCH FROM (now() - COALESCE(iniciado_em, now()))) * 1000)::integer
              )
        WHERE id_execucao = $1 AND ordem = $2`,
      [this.id, this.ordemDe(nome), detalhe],
    );
  }

  /** Roda a etapa medindo a duração e registrando sucesso ou falha. */
  async etapa<T>(
    nome: NomeEtapa,
    fn: () => Promise<{ resultado: T; detalhe: string }>,
  ): Promise<T> {
    await this.iniciarEtapa(nome);
    try {
      const { resultado, detalhe } = await fn();
      await this.concluirEtapa(nome, detalhe);
      return resultado;
    } catch (erro) {
      const msg = erro instanceof Error ? erro.message : String(erro);
      await this.falharEtapa(nome, msg);
      throw erro;
    }
  }

  /** Fecha as etapas que ficaram abertas: a em curso como erro, as demais ignoradas. */
  /** Troca o detalhe de uma etapa em curso, para o painel mostrar o avanço. */
  async detalharEtapa(nome: NomeEtapa, detalhe: string): Promise<void> {
    await pool.query(
      `UPDATE infoprice.ctl_execucao_etapa
          SET detalhe = $3
        WHERE id_execucao = $1 AND ordem = $2 AND status = 'em_curso'`,
      [this.id, this.ordemDe(nome), detalhe],
    );
  }

  async encerrarEtapasAbertas(detalhe: string): Promise<void> {
    await pool.query(
      `UPDATE infoprice.ctl_execucao_etapa
          SET status = CASE WHEN status = 'em_curso' THEN 'erro' ELSE 'ignorada' END,
              detalhe = CASE WHEN status = 'em_curso' THEN $2 ELSE COALESCE(detalhe, 'não executada') END,
              finalizado_em = COALESCE(finalizado_em, now())
        WHERE id_execucao = $1 AND status IN ('em_curso', 'pendente')`,
      [this.id, detalhe],
    );
  }

  async atualizar(campos: Record<string, unknown>): Promise<void> {
    const chaves = Object.keys(campos);
    if (chaves.length === 0) return;
    const sets = chaves.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await pool.query(
      `UPDATE infoprice.ctl_execucao SET ${sets} WHERE id = $1`,
      [this.id, ...chaves.map((c) => campos[c])],
    );
  }

  async finalizar(
    status: 'concluida' | 'parcial' | 'falha' | 'cancelada',
    erro?: string,
  ): Promise<void> {
    await pool.query(
      `UPDATE infoprice.ctl_execucao
          SET status = $2, finalizado_em = now(), erro = $3
        WHERE id = $1`,
      [this.id, status, erro ?? null],
    );
  }
}
