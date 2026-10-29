import type {
  Agendamento,
  Arquivo,
  CaminhoInverso,
  Etapa,
  EtapaFluxo,
  EventoLog,
  Execucao,
  Incidente,
  LinhagemArquivo,
  PastaInventario,
  ProgressoGravacao,
  Preco,
  RegraAlerta,
  Rejeicao,
} from './domain.js';

/** GET /api/status */
export interface StatusResposta {
  sftp: {
    host: string;
    usuario: string;
    chave: string;
    diretorioBase: string;
    conectado: boolean;
    verificadoEm: string | null;
  };
  agendamento: Agendamento;
  banco: {
    instancia: string;
    banco: string;
    schema: string;
  };
  /** A coleta em andamento, se houver — o cabeçalho oferece pará-la. */
  emAndamento: {
    id: number;
    runDate: string;
    iniciadoEm: string;
    /** A parada já foi pedida e a coleta está chegando a um ponto seguro. */
    parando: boolean;
  } | null;
}

/** GET /api/painel — a tela "Coleta do dia". */
export interface PainelResposta {
  runDate: string;
  execucao: Execucao | null;
  etapas: Etapa[];
  kpis: {
    status: string;
    janela: string;
    arquivos: string;
    bytes: string;
    linhas: string;
    linhasNota: string;
    rejeicoes: string;
  };
  aviso: {
    tag: string;
    texto: string;
    tom: 'ok' | 'atencao' | 'erro' | 'info';
  } | null;
  historico: Execucao[];
}

/** GET /api/execucoes/:id */
export interface DetalheExecucaoResposta {
  execucao: Execucao;
  resumo: string;
  cards: { rotulo: string; valor: string; nota: string }[];
  idempotencia: { chave: string; valor: string }[];
  sqlPersistencia: string;
  etapas: Etapa[];
  log: EventoLog[];
  totalEventos: number;
  arquivos: Arquivo[];
  /**
   * A gravação no banco: ao vivo enquanto a execução roda; depois dela, o
   * último ponto registrado — onde uma execução interrompida parou.
   */
  progresso: ProgressoGravacao | null;
  /** O retrato do banco em `progresso` foi tirado agora, nesta resposta. */
  progressoAoVivo: boolean;
}

/** GET /api/execucoes/:id/linhagem */
export interface LinhagemResposta {
  runDate: string;
  idExecucao: number;
  fluxo: EtapaFluxo[];
  porArquivo: LinhagemArquivo[];
}

/** GET /api/linhagem/preco/:id — o caminho inverso. */
export interface CaminhoInversoResposta {
  id: string;
  campos: CaminhoInverso[];
}

/** GET /api/inventario */
export interface InventarioResposta {
  cards: {
    pastasNaOrigem: number;
    arquivosPendentes: number;
    expiramEm24h: number;
    retencaoDias: number;
  };
  pastas: PastaInventario[];
  cargaInicial: {
    pasta: string;
    arquivos: number;
    linhas: number;
    desde: string;
  } | null;
}

/** GET /api/qualidade */
export interface QualidadeResposta {
  runDate: string;
  idExecucao: number | null;
  totalLinhas: number;
  totalRejeitadas: number;
  percentual: number;
  motivos: { nome: string; quantidade: number }[];
  rejeicoes: RejeicaoExplicada[];
  /** Execuções recentes, para escolher qual examinar. */
  execucoes: OpcaoExecucao[];
  /** Arquivos da execução com rejeições, para filtrar. */
  arquivos: { nome: string; quantidade: number }[];
  /** Rejeições que atendem aos filtros (a página mostra até porPagina). */
  filtradas: number;
  pagina: number;
  porPagina: number;
}

/** Campos interpretados que mais ajudam a entender uma rejeição. */
export type CamposRejeicao = Partial<
  Record<'gtin' | 'descricao' | 'id_loja' | 'preco' | 'preco_promocional' | 'data_coleta', string>
>;

export interface RejeicaoExplicada extends Rejeicao {
  /** O que, nesta linha, fez a regra disparar — com os valores dela. */
  explicacao: string;
  campos: CamposRejeicao;
}

export interface OpcaoExecucao {
  id: number;
  runDate: string;
  status: string;
  iniciadoEm: string;
  linhasRejeitadas: number;
}

/** GET /api/qualidade/rejeicoes/:id */
export interface DetalheRejeicaoResposta {
  rejeicao: RejeicaoExplicada;
  runDate: string;
  /** Cada coluna da linha original com o nome do cabeçalho do arquivo. */
  colunas: { nome: string; valor: string }[];
  colunasEsperadas: number;
  colunasLidas: number;
  delimitador: string | null;
  /** O cabeçalho do arquivo foi guardado (arquivos de antes desta versão, não). */
  cabecalhoConhecido: boolean;
}

/** Uma data que pode ser processada. */
export interface RunDisponivel {
  runDate: string;
  /** A pasta run= ainda está na origem (SFTP). */
  naOrigem: boolean;
  arquivosOrigem: number;
  /** Há cópia local na área temporária — permite processar mesmo fora da origem. */
  copiaLocal: boolean;
  arquivosLocais: number;
  ultimaExecucao: {
    id: number;
    status: string;
    finalizadoEm: string | null;
    linhasGravadas: number;
    linhasRejeitadas: number;
  } | null;
}

/** GET /api/runs */
export interface RunsResposta {
  hoje: string;
  runs: RunDisponivel[];
  /** A origem não respondeu: só as cópias locais e o histórico aparecem. */
  erroOrigem: string | null;
  retencaoOrigemDias: number;
  retencaoLocalDias: number;
}

/** GET /api/incidentes */
export interface IncidentesResposta {
  incidentes: Incidente[];
  regras: RegraAlerta[];
  abertos: number;
}

/** GET /api/precos */
export interface PrecosResposta {
  total: number;
  exibindo: number;
  atualizadoEm: string | null;
  filtros: FiltroPrecos;
  linhas: Preco[];
}

export interface FiltroPrecos {
  data?: string;
  uf?: string;
  busca?: string;
  tipo?: string;
  limite?: number;
}

/** GET /api/config */
export interface ConfigResposta {
  blocos: { titulo: string; linhas: { chave: string; valor: string }[] }[];
  tabelas: { nome: string; descricao: string }[];
}

/** Resposta padrão das ações que devolvem uma mensagem para o toast. */
export interface AcaoResposta {
  ok: boolean;
  mensagem: string;
  idExecucao?: number;
}

export interface ErroResposta {
  erro: string;
  detalhe?: string;
}

/** O que existe na base hoje — o que um reset apagaria. */
export interface ContagensBase {
  execucoes: number;
  arquivos: number;
  /** Estimativa do PostgreSQL: contar o fato inteiro levaria minutos. */
  precos: number;
  rejeicoes: number;
  incidentes: number;
  lojas: number;
  eventosLog: number;
  tentativasLogin: number;
  usuarios: number;
}

export interface UltimoReset {
  executadoEm: string;
  executadoPor: string;
  origem: string;
}

/** GET /api/admin/base */
export interface ResumoBaseResposta {
  contagens: ContagensBase;
  /** Onde ficam as cópias locais dos arquivos baixados. */
  areaTemporaria: string;
  /** Frase que precisa ser digitada para confirmar. */
  frase: string;
  coletaEmAndamento: boolean;
  /** Id da coleta em andamento, para a tela oferecer pará-la. */
  idEmAndamento: number | null;
  ultimoReset: UltimoReset | null;
}

/** POST /api/admin/base/zerar */
export interface ZerarBasePedido {
  confirmacao: string;
  senha: string;
  apagarArquivos: boolean;
}

export interface ZerarBaseResposta extends AcaoResposta {
  apagado: ContagensBase;
  arquivosRemovidos: number;
}
