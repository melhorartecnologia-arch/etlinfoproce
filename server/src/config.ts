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
  /** Origens autorizadas quando o console é servido de outro host. */
  origensPermitidas: lista('ORIGENS_PERMITIDAS', ''),

  auth: {
    duracaoSessaoHoras: numero('SESSAO_DURACAO_HORAS', 12),
    maxTentativas: numero('LOGIN_MAX_TENTATIVAS', 5),
    janelaTentativasMin: numero('LOGIN_JANELA_MIN', 15),
    /**
     * Marca o cookie como Secure. Ligue em produção, onde o console fica atrás
     * de HTTPS; em desenvolvimento (http://localhost) o cookie Secure não é
     * aceito pelo navegador.
     */
    cookieSeguro: booleano('COOKIE_SEGURO', texto('NODE_ENV', '') === 'production'),
  },

  banco: {
    host: texto('PGHOST', '127.0.0.1'),
    porta: numero('PGPORT', 5432),
    banco: texto('PGDATABASE', 'dw_precos'),
    usuario: texto('PGUSER', 'infoprice'),
    senha: texto('PGPASSWORD', 'infoprice'),
    schema: texto('PGSCHEMA', 'infoprice'),
    instanciaRotulo: texto('INSTANCIA_ROTULO', 'postgres.interno:5432'),
    maxConexoes: numero('PGPOOL_MAX', 10),

    /**
     * Modo de TLS.
     *
     *   verify-full  cifra e confere o certificado contra a CA da AWS e o
     *                hostname. É o correto para RDS, e o padrão quando o host
     *                termina em .rds.amazonaws.com.
     *   require      cifra mas não confere o certificado. Protege contra
     *                escuta passiva, não contra interceptação ativa. Só use se
     *                não houver como provisionar o bundle de CA.
     *   disable      sem TLS. Aceitável apenas para PostgreSQL local.
     */
    sslModo: texto(
      'PGSSLMODE',
      /\.rds\.amazonaws\.com$/i.test(texto('PGHOST', ''))
        ? 'verify-full'
        : 'disable',
    ) as 'verify-full' | 'require' | 'disable',

    /** Bundle de CAs do RDS. Baixe com `npm run baixar-ca-rds`. */
    caRds: caminho('CA_RDS', './certs/rds-global-bundle.pem'),

    /**
     * De onde vem a senha:
     *   env             PGPASSWORD (simples, mas a senha fica no ambiente)
     *   secrets-manager segredo do AWS Secrets Manager, com rotação
     *   iam             token do IAM, válido por 15 min e renovado a cada
     *                   conexão; não existe senha para vazar
     */
    credencial: texto('PG_CREDENCIAL', 'env') as
      | 'env'
      | 'secrets-manager'
      | 'iam',
    /** ARN ou nome do segredo, quando credencial=secrets-manager. */
    segredoArn: texto('PG_SEGREDO_ARN', ''),
    regiaoAws: texto('AWS_REGION', 'sa-east-1'),

    // ── Tempos, calibrados para um salto de rede até o RDS ─────────────────
    /** Espera por uma conexão livre no pool. */
    timeoutConexaoMs: numero('PG_TIMEOUT_CONEXAO_MS', 10_000),
    /** Fecha conexões ociosas antes que o RDS ou um NAT as derrube. */
    timeoutOciosaMs: numero('PG_TIMEOUT_OCIOSA_MS', 30_000),
    /**
     * Teto para uma consulta comum. O merge da ingestão é exceção e ajusta o
     * próprio limite na transação — ver PG_TIMEOUT_INGESTAO_MS.
     */
    timeoutConsultaMs: numero('PG_TIMEOUT_CONSULTA_MS', 30_000),
    /** Teto para as etapas pesadas: COPY, regras de qualidade e merge. */
    timeoutIngestaoMs: numero('PG_TIMEOUT_INGESTAO_MS', 3_600_000),
    /**
     * Derruba a sessão que ficar parada dentro de uma transação. Sem isto, um
     * processo travado no meio da ingestão seguraria locks no RDS até alguém
     * notar.
     */
    timeoutTransacaoOciosaMs: numero('PG_TIMEOUT_TRANSACAO_OCIOSA_MS', 120_000),
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
