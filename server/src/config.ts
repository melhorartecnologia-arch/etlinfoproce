import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raizServidor = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function texto(chave: string, padrao: string): string {
  const v = process.env[chave];
  return v === undefined || v === '' ? padrao : v;
}

function numero(chave: string, padrao: number): number {
  const v = process.env[chave];
  if (v === undefined || v === '') return padrao;
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

function booleano(chave: string, padrao: boolean): boolean {
  const v = process.env[chave];
  if (v === undefined || v === '') return padrao;
  return ['1', 'true', 'sim', 'yes', 'on'].includes(v.toLowerCase());
}

/** Resolve caminhos relativos a partir da raiz do pacote do servidor. */
function caminho(chave: string, padrao: string): string {
  const v = texto(chave, padrao);
  return path.isAbsolute(v) ? v : path.resolve(raizServidor, v);
}

function lista(chave: string, padrao: string): string[] {
  return texto(chave, padrao)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  raizServidor,
  porta: numero('PORT', 3001),
  ambiente: texto('NODE_ENV', 'development'),
  operadorPadrao: texto('OPERADOR_PADRAO', 'operador'),

  banco: {
    host: texto('PGHOST', '127.0.0.1'),
    porta: numero('PGPORT', 5432),
    banco: texto('PGDATABASE', 'dw_precos'),
    usuario: texto('PGUSER', 'infoprice'),
    senha: texto('PGPASSWORD', 'infoprice'),
    schema: texto('PGSCHEMA', 'infoprice'),
    instanciaRotulo: texto('INSTANCIA_ROTULO', 'postgres.interno:5432'),
    maxConexoes: numero('PGPOOL_MAX', 10),
  },

  sftp: {
    /** 'sftp' fala com o servidor real; 'local' lê de um diretório do disco. */
    driver: texto('SFTP_DRIVER', 'local') as 'sftp' | 'local',
    host: texto('SFTP_HOST', 'sftp.exemplo.com.br'),
    porta: numero('SFTP_PORT', 22),
    usuario: texto('SFTP_USUARIO', 'usuario-sftp'),
    chavePrivada: texto('SFTP_CHAVE_PRIVADA', ''),
    chavePassphrase: texto('SFTP_CHAVE_PASSPHRASE', ''),
    senha: texto('SFTP_SENHA', ''),
    diretorioBase: texto(
      'SFTP_DIRETORIO_BASE',
      '/home/usuario-sftp/output/ISA-InfoPanel',
    ),
    timeoutMs: numero('SFTP_TIMEOUT_MS', 30_000),
    diretorioLocal: caminho(
      'SFTP_DIRETORIO_LOCAL',
      './var/sftp-local/output/ISA-InfoPanel',
    ),
  },

  coleta: {
    areaTemporaria: caminho('AREA_TEMPORARIA', './var/spool/infoprice'),
    paralelismo: numero('DOWNLOAD_PARALELISMO', 4),
    retencaoOrigemDias: numero('RETENCAO_ORIGEM_DIAS', 5),
    retencaoLocalDias: numero('RETENCAO_LOCAL_DIAS', 30),
    colunasEsperadas: numero('COLUNAS_ESPERADAS', 42),
    fonte: texto('FONTE', 'ISA-InfoPanel'),
    padraoPasta: /^run=(\d{4}-\d{2}-\d{2})$/,
  },

  agendamento: {
    ativo: booleano('AGENDAMENTO_ATIVO', true),
    cronColeta: texto('CRON_COLETA', '30 5 * * *'),
    cronVarredura: texto('CRON_VARREDURA', '0 12,18 * * *'),
    cronResumo: texto('CRON_RESUMO', '0 6 * * *'),
    timezone: texto('TIMEZONE', 'America/Sao_Paulo'),
    tentativas: numero('TENTATIVAS', 3),
    esperasMin: lista('ESPERA_TENTATIVAS_MIN', '10,20,40').map(Number),
    toleranciaAte: texto('TOLERANCIA_ATE', '09:00'),
    desvioVolumePct: numero('DESVIO_VOLUME_PCT', 25),
    limiteRejeicoesPct: numero('LIMITE_REJEICOES_PCT', 0.5),
  },

  alertas: {
    smtpHost: texto('SMTP_HOST', ''),
    smtpPorta: numero('SMTP_PORT', 587),
    smtpUsuario: texto('SMTP_USUARIO', ''),
    smtpSenha: texto('SMTP_SENHA', ''),
    remetente: texto('SMTP_REMETENTE', 'console-ingestao@infoprice.local'),
    destinatarios: lista('ALERTA_DESTINATARIOS', 'equipe-dados@exemplo.com.br'),
    resumoDestinatarios: lista(
      'RESUMO_DESTINATARIOS',
      'equipe-dados@exemplo.com.br',
    ),
  },
} as const;

export type Config = typeof config;
