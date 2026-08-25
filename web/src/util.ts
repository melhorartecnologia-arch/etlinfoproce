import type {
  Severidade,
  StatusEtapa,
  StatusExecucao,
} from '@infoprice/shared';

export function numeroBR(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('pt-BR');
}

export function moedaBR(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'string' ? Number(v) : v;
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function bytesBR(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '0 B';
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < unidades.length - 1) {
    v /= 1024;
    i += 1;
  }
  const casas = i === 0 ? 0 : v >= 100 ? 0 : 1;
  return `${v.toLocaleString('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  })} ${unidades[i]}`;
}

export function duracaoBR(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const totalSeg = Math.round(ms / 1000);
  const h = Math.floor(totalSeg / 3600);
  const m = Math.floor((totalSeg % 3600) / 60);
  const s = totalSeg % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** mm:ss — a duração de cada etapa, como no protótipo. */
export function duracaoCurta(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms < 0) return '—';
  const totalSeg = Math.round(ms / 1000);
  const m = Math.floor(totalSeg / 60);
  const s = totalSeg % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Fuso em que os horários são exibidos.
 *
 * O agendamento é definido em America/Sao_Paulo, e é nesse fuso que a operação
 * raciocina ("a coleta das 05:30"). Mostrar no fuso do navegador faria a mesma
 * execução aparecer em horários diferentes conforme quem abre a tela, então o
 * servidor manda o fuso na configuração e todas as telas seguem ele.
 */
let fusoExibicao: string | undefined;

export function definirFuso(tz: string | undefined): void {
  fusoExibicao = tz;
}

export function hora(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', {
    timeZone: fusoExibicao,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function horaCurta(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('pt-BR', {
    timeZone: fusoExibicao,
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function dataHoraBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    timeZone: fusoExibicao,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function dataBR(data: string | null | undefined): string {
  if (!data) return '—';
  const [a, m, d] = data.split('-');
  return d ? `${d}/${m}/${a}` : data;
}

export function percentualBR(v: number, casas = 2): string {
  return `${v.toLocaleString('pt-BR', {
    minimumFractionDigits: casas,
    maximumFractionDigits: casas,
  })}%`;
}

/** Data de hoje em AAAA-MM-DD, no fuso de exibição. */
export function hoje(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fusoExibicao,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** "carga incremental" · "reprocessamento" · "carga histórica" */
export function rotuloTipo(tipo: string): string {
  switch (tipo) {
    case 'incremental': return 'carga incremental';
    case 'reprocessamento': return 'reprocessamento';
    case 'carga_historica': return 'carga histórica';
    default: return tipo.replace(/_/g, ' ');
  }
}

export function rotuloStatus(status: StatusExecucao): string {
  switch (status) {
    case 'concluida': return 'Concluída';
    case 'em_execucao': return 'Em execução';
    case 'parcial': return 'Parcial';
    case 'falha': return 'Falha';
    case 'cancelada': return 'Cancelada';
    default: return status;
  }
}

export type Tom = 'ok' | 'atencao' | 'erro' | 'exec' | 'neutro';

export function tomDoStatus(status: StatusExecucao): Tom {
  switch (status) {
    case 'concluida': return 'ok';
    case 'parcial': return 'atencao';
    case 'falha': return 'erro';
    case 'em_execucao': return 'exec';
    default: return 'neutro';
  }
}

export function tomDaSeveridade(sev: Severidade): Tom {
  switch (sev) {
    case 'Crítico': return 'erro';
    case 'Atenção': return 'atencao';
    default: return 'exec';
  }
}

/** Cor do valor de status no KPI da tela do dia. */
export function corDoStatus(status: StatusExecucao): string {
  switch (status) {
    case 'concluida': return 'oklch(0.6 0.13 150)';
    case 'falha': return 'oklch(0.55 0.19 25)';
    case 'em_execucao': return 'oklch(0.52 0.15 250)';
    case 'parcial': return 'oklch(0.55 0.13 60)';
    default: return 'oklch(0.5 0.01 85)';
  }
}

export function classeEtapa(status: StatusEtapa): string {
  return `etapa__ponto etapa__ponto--${status}`;
}

/** Cor da barra de cada motivo de rejeição, por posição no ranking. */
export function corDoMotivo(indice: number): string {
  const cores = [
    'oklch(0.55 0.19 25)',
    'oklch(0.55 0.19 25)',
    'oklch(0.6 0.13 60)',
    'oklch(0.6 0.13 60)',
    'oklch(0.55 0.14 250)',
    'oklch(0.55 0.14 250)',
  ];
  return cores[Math.min(indice, cores.length - 1)]!;
}

export function abreviarHash(hash: string | null | undefined): string {
  if (!hash) return '—';
  return `${hash.slice(0, 4)}…${hash.slice(-4)}`;
}
