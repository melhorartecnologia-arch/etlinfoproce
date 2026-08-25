/**
 * Tipos de domínio compartilhados entre o servidor de ingestão e o console web.
 * Os nomes seguem o vocabulário do processo (pt-BR), igual ao que aparece na tela.
 */

/** Situação de uma execução de coleta. */
export type StatusExecucao =
  | 'em_execucao'
  | 'concluida'
  | 'parcial'
  | 'falha'
  | 'cancelada';

/** O que disparou a execução. */
export type GatilhoExecucao =
  | 'agendador'
  | 'manual'
  | 'varredura'
  | 'retentativa'
  | 'reprocessamento';

/** Natureza da carga. */
export type TipoExecucao =
  | 'incremental'
  | 'reprocessamento'
  | 'carga_historica';

/** Situação de cada uma das 10 etapas do processo. */
export type StatusEtapa = 'pendente' | 'em_curso' | 'ok' | 'erro' | 'ignorada';

/** Nível de um evento no log técnico. */
export type NivelLog = 'DEBUG' | 'INFO' | 'WARN' | 'ERRO';

/** Situação de um arquivo dentro do inventário / da execução. */
export type StatusArquivo =
  | 'visto'
  | 'baixado'
  | 'ingerido'
  | 'rejeitado'
  | 'arquivado'
  | 'erro';

export type Severidade = 'Crítico' | 'Atenção' | 'Informativo';

export type StatusIncidente = 'aberto' | 'resolvido';

/** As 10 etapas do processo, na ordem em que rodam. */
export const ETAPAS_PROCESSO = [
  'Conexão SFTP',
  'Listagem do diretório',
  'Download para área temporária',
  'Verificação de integridade',
  'Validação de schema',
  'Carga em staging',
  'Regras de qualidade',
  'Merge incremental',
  'Auditoria e watermark',
  'Notificação',
] as const;

export type NomeEtapa = (typeof ETAPAS_PROCESSO)[number];

/** Os seis motivos de rejeição aplicados sobre o staging. */
export const MOTIVOS_REJEICAO = [
  'GTIN inválido no dígito verificador',
  'Preço menor ou igual a zero',
  'Loja ausente em dim_loja',
  'Data de coleta fora da janela do run',
  'Duplicidade na chave de conflito',
  'Caractere inválido na descrição',
] as const;

export type MotivoRejeicao = (typeof MOTIVOS_REJEICAO)[number];

export interface Execucao {
  id: number;
  runDate: string;
  tipo: TipoExecucao;
  gatilho: GatilhoExecucao;
  assinatura: string;
  iniciadoEm: string;
  finalizadoEm: string | null;
  duracaoMs: number | null;
  status: StatusExecucao;
  arquivosVistos: number;
  arquivosIngeridos: number;
  bytesBaixados: number;
  linhasStaging: number;
  linhasGravadas: number;
  linhasInseridas: number;
  linhasAtualizadas: number;
  linhasRejeitadas: number;
  watermarkAnterior: string | null;
  watermarkNovo: string | null;
  erro: string | null;
}

export interface Etapa {
  ordem: number;
  nome: NomeEtapa;
  detalhe: string | null;
  status: StatusEtapa;
  iniciadoEm: string | null;
  finalizadoEm: string | null;
  duracaoMs: number | null;
}

export interface EventoLog {
  id: number;
  ts: string;
  nivel: NivelLog;
  mensagem: string;
}

export interface Arquivo {
  id: number;
  idExecucao: number | null;
  pasta: string;
  nome: string;
  caminhoRemoto: string;
  tamanhoBytes: number;
  sha256: string | null;
  sha256Descompactado: string | null;
  vistoEm: string | null;
  baixadoEm: string | null;
  ingeridoEm: string | null;
  linhasLidas: number;
  linhasGravadas: number;
  linhasRejeitadas: number;
  linhasInseridas: number;
  linhasAtualizadas: number;
  destino: string | null;
  status: StatusArquivo;
  expiraEm: string | null;
  temCopiaLocal: boolean;
}

export interface Rejeicao {
  id: number;
  idExecucao: number;
  arquivo: string;
  numeroLinha: number;
  motivo: string;
  payload: string;
  tratamento: string;
  criadoEm: string;
}

export interface Incidente {
  id: number;
  codigo: string;
  severidade: Severidade;
  titulo: string;
  detalhe: string;
  abertoEm: string;
  idExecucao: number | null;
  runDate: string | null;
  canal: string;
  status: StatusIncidente;
  resolvidoEm: string | null;
  resolvidoPor: string | null;
  resolucao: string | null;
  duracaoMs: number | null;
}

export interface RegraAlerta {
  id: number;
  condicao: string;
  severidade: Severidade;
  canal: string;
  destinatario: string;
  ativa: boolean;
}

export interface Agendamento {
  pausado: boolean;
  cron: string;
  timezone: string;
  proximaExecucao: string | null;
  pausadoEm: string | null;
  pausadoPor: string | null;
}

export interface Preco {
  id: string;
  gtin: string;
  descricao: string;
  idLoja: string;
  rede: string | null;
  uf: string | null;
  preco: string;
  precoPromocional: string | null;
  tipoPreco: string;
  dataColeta: string;
  fonte: string;
  idExecucao: number;
  idArquivo: number;
  numeroLinha: number;
  arquivo: string;
  criadoEm: string;
  atualizadoEm: string;
}

export interface PastaInventario {
  pasta: string;
  runDate: string;
  arquivos: number;
  bytes: number;
  vistoEm: string | null;
  ingeridoEm: string | null;
  expiraEm: string | null;
  expiraEmDias: number | null;
  situacao: string;
  status: StatusArquivo;
  idExecucao: number | null;
  pendentes: number;
}

export interface LinhagemArquivo {
  idArquivo: number;
  arquivo: string;
  noArquivo: number;
  staging: number;
  rejeitadas: number;
  inseridas: number;
  atualizadas: number;
  particao: string;
  idExecucao: number;
}

export interface EtapaFluxo {
  etapa: string;
  objeto: string;
  quantidade: number;
  nota: string;
  tom: 'neutro' | 'atencao' | 'ok';
}

export interface CaminhoInverso {
  chave: string;
  valor: string;
}
