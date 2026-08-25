import { config } from '../config.js';

/**
 * Data no fuso do agendamento, no formato AAAA-MM-DD.
 * O run é sempre nomeado pelo dia em São Paulo, independente do fuso do host.
 */
export function dataLocal(quando: Date = new Date()): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.agendamento.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(quando);

  const pega = (tipo: string) =>
    partes.find((p) => p.type === tipo)?.value ?? '00';

  return `${pega('year')}-${pega('month')}-${pega('day')}`;
}

/** Hora local HH:MM no fuso do agendamento. */
export function horaLocal(quando: Date = new Date()): string {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: config.agendamento.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(quando);
}

/** Soma dias a uma data AAAA-MM-DD sem depender do fuso do processo. */
export function somarDias(data: string, dias: number): string {
  const [a, m, d] = data.split('-').map(Number);
  const dt = new Date(Date.UTC(a!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

/** Diferença em dias inteiros entre duas datas AAAA-MM-DD (b - a). */
export function diferencaDias(a: string, b: string): number {
  const ms =
    Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** true quando a hora local já passou de HH:MM. */
export function passouDe(limite: string, quando: Date = new Date()): boolean {
  return horaLocal(quando) >= limite;
}

export function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
