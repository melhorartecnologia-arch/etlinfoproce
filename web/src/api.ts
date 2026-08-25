import type {
  AcaoResposta,
  ConfigResposta,
  DetalheExecucaoResposta,
  IncidentesResposta,
  InventarioResposta,
  LinhagemResposta,
  PainelResposta,
  PrecosResposta,
  QualidadeResposta,
  StatusResposta,
} from '@infoprice/shared';

const BASE = '/api';

export class ErroApi extends Error {
  constructor(
    mensagem: string,
    readonly status: number,
  ) {
    super(mensagem);
    this.name = 'ErroApi';
  }
}

async function pegar<T>(caminho: string, init?: RequestInit): Promise<T> {
  const resposta = await fetch(`${BASE}${caminho}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!resposta.ok) {
    let mensagem = `falha na requisição (${resposta.status})`;
    try {
      const corpo = await resposta.json();
      if (corpo?.erro) mensagem = corpo.erro;
    } catch {
      // resposta sem JSON — mantém a mensagem genérica
    }
    throw new ErroApi(mensagem, resposta.status);
  }

  return (await resposta.json()) as T;
}

function enviar<T>(caminho: string, corpo?: unknown): Promise<T> {
  return pegar<T>(caminho, {
    method: 'POST',
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
}

export const api = {
  status: () => pegar<StatusResposta>('/status'),
  painel: (run?: string) =>
    pegar<PainelResposta>(`/painel${run ? `?run=${run}` : ''}`),
  execucao: (id: number) => pegar<DetalheExecucaoResposta>(`/execucoes/${id}`),
  linhagem: (id: number) => pegar<LinhagemResposta>(`/execucoes/${id}/linhagem`),
  linhagemExemplo: (idExecucao?: number) =>
    pegar<{ id: string | null; campos: { chave: string; valor: string }[] }>(
      `/linhagem/exemplo${idExecucao ? `?execucao=${idExecucao}` : ''}`,
    ),
  caminhoInverso: (id: string) =>
    pegar<{ id: string; campos: { chave: string; valor: string }[] }>(
      `/linhagem/preco/${id}`,
    ),
  inventario: () => pegar<InventarioResposta>('/inventario'),
  qualidade: (run?: string) =>
    pegar<QualidadeResposta>(`/qualidade${run ? `?run=${run}` : ''}`),
  incidentes: () => pegar<IncidentesResposta>('/incidentes'),
  config: () => pegar<ConfigResposta>('/config'),
  ufs: () => pegar<string[]>('/precos/ufs'),

  precos: (filtros: {
    data?: string;
    uf?: string;
    busca?: string;
    tipo?: string;
    limite?: number;
  }) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filtros)) {
      if (v !== undefined && v !== '' && v !== 'Todas' && v !== 'Todos') {
        p.set(k, String(v));
      }
    }
    const consulta = p.toString();
    return pegar<PrecosResposta>(`/precos${consulta ? `?${consulta}` : ''}`);
  },

  // ── Ações ────────────────────────────────────────────────────────────────
  coletaManual: (run?: string) => enviar<AcaoResposta>('/execucoes', { run }),
  pausar: () => enviar<AcaoResposta>('/agendamento/pausar'),
  retomar: () => enviar<AcaoResposta>('/agendamento/retomar'),
  reprocessarRun: (id: number) =>
    enviar<AcaoResposta>(`/execucoes/${id}/reprocessar`),
  reprocessarArquivo: (id: number) =>
    enviar<AcaoResposta>(`/arquivos/${id}/reprocessar`),
  reprocessarPasta: (pasta: string) =>
    enviar<AcaoResposta>(`/inventario/${encodeURIComponent(pasta)}/reprocessar`),
  resolverIncidente: (codigo: string) =>
    enviar<AcaoResposta>(`/incidentes/${encodeURIComponent(codigo)}/resolver`),

  // ── Downloads ────────────────────────────────────────────────────────────
  urlDownloadArquivo: (id: number) => `${BASE}/arquivos/${id}/download`,
  urlDownloadPasta: (pasta: string) =>
    `${BASE}/inventario/${encodeURIComponent(pasta)}/download`,
  urlAuditoriaCsv: (id: number) => `${BASE}/execucoes/${id}/auditoria.csv`,
  urlAuditoriaPdf: (id: number) => `${BASE}/execucoes/${id}/auditoria.pdf`,
  urlRejeicoesCsv: (run: string) =>
    `${BASE}/qualidade/rejeicoes.csv?run=${run}`,
  urlPrecosCsv: (filtros: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(filtros)) {
      if (v && v !== 'Todas' && v !== 'Todos') p.set(k, v);
    }
    const consulta = p.toString();
    return `${BASE}/precos.csv${consulta ? `?${consulta}` : ''}`;
  },
};
