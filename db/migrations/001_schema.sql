-- ─────────────────────────────────────────────────────────────────────────────
-- 001 · Estrutura base do console de ingestão InfoPrice
--
-- Convenções:
--   ctl_*  tabelas de controle e rastreabilidade
--   stg_*  espelho do arquivo recebido, apagado e recarregado a cada run
--   fact_* dado final, com id_execucao e id_arquivo em cada linha
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS infoprice;

-- gen_random_uuid() é nativo desde o PostgreSQL 13, que é o piso das versões
-- disponíveis no RDS. Em bases mais antigas ele vem do pgcrypto — tentamos
-- criar a extensão, mas sem abortar se o usuário não tiver permissão: no RDS o
-- usuário mestre não é superusuário, e num PostgreSQL 13+ a extensão é
-- dispensável de qualquer forma.
DO $$
BEGIN
  IF current_setting('server_version_num')::integer < 130000 THEN
    BEGIN
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION
        'PostgreSQL % exige a extensão pgcrypto para gen_random_uuid(), e este '
        'usuário não pode criá-la. Peça a um administrador: CREATE EXTENSION pgcrypto;',
        current_setting('server_version');
    END;
  END IF;
END
$$;

-- ── Execuções ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_execucao (
  id                   bigserial PRIMARY KEY,
  run_date             date        NOT NULL,
  tipo                 text        NOT NULL DEFAULT 'incremental'
                         CHECK (tipo IN ('incremental', 'reprocessamento', 'carga_historica')),
  gatilho              text        NOT NULL DEFAULT 'agendador'
                         CHECK (gatilho IN ('agendador', 'manual', 'varredura', 'retentativa', 'reprocessamento')),
  assinatura           text        NOT NULL,
  fonte                text        NOT NULL DEFAULT 'ISA-InfoPanel',
  iniciado_em          timestamptz NOT NULL DEFAULT now(),
  finalizado_em        timestamptz,
  status               text        NOT NULL DEFAULT 'em_execucao'
                         CHECK (status IN ('em_execucao', 'concluida', 'parcial', 'falha', 'cancelada')),
  arquivos_vistos      integer     NOT NULL DEFAULT 0,
  arquivos_ingeridos   integer     NOT NULL DEFAULT 0,
  bytes_baixados       bigint      NOT NULL DEFAULT 0,
  linhas_staging       bigint      NOT NULL DEFAULT 0,
  linhas_gravadas      bigint      NOT NULL DEFAULT 0,
  linhas_inseridas     bigint      NOT NULL DEFAULT 0,
  linhas_atualizadas   bigint      NOT NULL DEFAULT 0,
  linhas_rejeitadas    bigint      NOT NULL DEFAULT 0,
  watermark_anterior   date,
  watermark_novo       date,
  tentativa            smallint    NOT NULL DEFAULT 1,
  erro                 text,
  criado_em            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE infoprice.ctl_execucao IS
  'Uma linha por execução: gatilho, início, fim, status, watermark.';

CREATE INDEX IF NOT EXISTS ix_execucao_run_date  ON infoprice.ctl_execucao (run_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS ix_execucao_status    ON infoprice.ctl_execucao (status);
CREATE INDEX IF NOT EXISTS ix_execucao_iniciado  ON infoprice.ctl_execucao (iniciado_em DESC);

-- Só uma execução pode estar em andamento por vez: evita que o agendador e uma
-- coleta manual disparem o mesmo run em paralelo.
CREATE UNIQUE INDEX IF NOT EXISTS ux_execucao_em_andamento
  ON infoprice.ctl_execucao (status) WHERE status = 'em_execucao';

-- ── Etapas do processo ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_execucao_etapa (
  id             bigserial PRIMARY KEY,
  id_execucao    bigint      NOT NULL REFERENCES infoprice.ctl_execucao (id) ON DELETE CASCADE,
  ordem          smallint    NOT NULL,
  nome           text        NOT NULL,
  detalhe        text,
  status         text        NOT NULL DEFAULT 'pendente'
                   CHECK (status IN ('pendente', 'em_curso', 'ok', 'erro', 'ignorada')),
  iniciado_em    timestamptz,
  finalizado_em  timestamptz,
  duracao_ms     integer,
  UNIQUE (id_execucao, ordem)
);

COMMENT ON TABLE infoprice.ctl_execucao_etapa IS
  'As 10 etapas do processo por execução, com duração individual.';

-- ── Log técnico ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_execucao_log (
  id           bigserial PRIMARY KEY,
  id_execucao  bigint      NOT NULL REFERENCES infoprice.ctl_execucao (id) ON DELETE CASCADE,
  ts           timestamptz NOT NULL DEFAULT clock_timestamp(),
  nivel        text        NOT NULL DEFAULT 'INFO'
                 CHECK (nivel IN ('DEBUG', 'INFO', 'WARN', 'ERRO')),
  mensagem     text        NOT NULL
);

COMMENT ON TABLE infoprice.ctl_execucao_log IS
  'Eventos em ordem cronológica, com nível e mensagem.';

CREATE INDEX IF NOT EXISTS ix_log_execucao ON infoprice.ctl_execucao_log (id_execucao, id);

-- ── Arquivos ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_arquivo (
  id                    bigserial PRIMARY KEY,
  id_execucao           bigint      REFERENCES infoprice.ctl_execucao (id) ON DELETE SET NULL,
  pasta                 text        NOT NULL,
  run_date              date        NOT NULL,
  nome                  text        NOT NULL,
  caminho_remoto        text        NOT NULL,
  caminho_local         text,
  tamanho_bytes         bigint      NOT NULL DEFAULT 0,
  modificado_em         timestamptz,
  sha256                text,
  sha256_descompactado  text,
  visto_em              timestamptz NOT NULL DEFAULT now(),
  baixado_em            timestamptz,
  ingerido_em           timestamptz,
  linhas_lidas          bigint      NOT NULL DEFAULT 0,
  linhas_gravadas       bigint      NOT NULL DEFAULT 0,
  linhas_rejeitadas     bigint      NOT NULL DEFAULT 0,
  linhas_inseridas      bigint      NOT NULL DEFAULT 0,
  linhas_atualizadas    bigint      NOT NULL DEFAULT 0,
  destino               text,
  status                text        NOT NULL DEFAULT 'visto'
                          CHECK (status IN ('visto', 'baixado', 'ingerido', 'rejeitado', 'arquivado', 'erro')),
  erro                  text,
  expira_em             date,
  atualizado_em         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE infoprice.ctl_arquivo IS
  'Cada arquivo visto na origem, com hash, tamanho e horários de download e ingestão.';

-- A identidade de um arquivo é (pasta, nome): reencontrá-lo numa varredura
-- posterior atualiza a linha existente em vez de duplicar o inventário.
CREATE UNIQUE INDEX IF NOT EXISTS ux_arquivo_pasta_nome ON infoprice.ctl_arquivo (pasta, nome);
CREATE INDEX IF NOT EXISTS ix_arquivo_execucao ON infoprice.ctl_arquivo (id_execucao);
CREATE INDEX IF NOT EXISTS ix_arquivo_run_date ON infoprice.ctl_arquivo (run_date DESC);
CREATE INDEX IF NOT EXISTS ix_arquivo_status   ON infoprice.ctl_arquivo (status);

-- ── Rejeições ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_rejeicao (
  id            bigserial PRIMARY KEY,
  id_execucao   bigint      NOT NULL REFERENCES infoprice.ctl_execucao (id) ON DELETE CASCADE,
  id_arquivo    bigint      REFERENCES infoprice.ctl_arquivo (id) ON DELETE SET NULL,
  arquivo       text        NOT NULL,
  numero_linha  bigint      NOT NULL,
  motivo        text        NOT NULL,
  payload       text        NOT NULL,
  tratamento    text        NOT NULL DEFAULT 'Aguardando correção na origem',
  criado_em     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE infoprice.ctl_rejeicao IS
  'Linha rejeitada, motivo, payload original e tratamento.';

CREATE INDEX IF NOT EXISTS ix_rejeicao_execucao ON infoprice.ctl_rejeicao (id_execucao);
CREATE INDEX IF NOT EXISTS ix_rejeicao_motivo   ON infoprice.ctl_rejeicao (id_execucao, motivo);

-- ── Incidentes ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_incidente (
  id             bigserial PRIMARY KEY,
  codigo         text        NOT NULL UNIQUE,
  severidade     text        NOT NULL CHECK (severidade IN ('Crítico', 'Atenção', 'Informativo')),
  titulo         text        NOT NULL,
  detalhe        text        NOT NULL,
  aberto_em      timestamptz NOT NULL DEFAULT now(),
  id_execucao    bigint      REFERENCES infoprice.ctl_execucao (id) ON DELETE SET NULL,
  run_date       date,
  canal          text        NOT NULL DEFAULT 'e-mail + painel',
  status         text        NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'resolvido')),
  resolvido_em   timestamptz,
  resolvido_por  text,
  resolucao      text,
  chave_dedupe   text
);

-- Impede que a mesma condição no mesmo run abra um incidente por tentativa.
CREATE UNIQUE INDEX IF NOT EXISTS ux_incidente_aberto_dedupe
  ON infoprice.ctl_incidente (chave_dedupe) WHERE status = 'aberto' AND chave_dedupe IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_incidente_status ON infoprice.ctl_incidente (status, aberto_em DESC);

-- ── Regras de notificação ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_regra_alerta (
  id            bigserial PRIMARY KEY,
  chave         text        NOT NULL UNIQUE,
  condicao      text        NOT NULL,
  severidade    text        NOT NULL CHECK (severidade IN ('Crítico', 'Atenção', 'Informativo')),
  canal         text        NOT NULL,
  destinatario  text        NOT NULL DEFAULT '—',
  ativa         boolean     NOT NULL DEFAULT true,
  ordem         smallint    NOT NULL DEFAULT 0
);

-- ── Agendamento ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_agendamento (
  id          smallint    PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pausado     boolean     NOT NULL DEFAULT false,
  cron        text        NOT NULL DEFAULT '30 5 * * *',
  timezone    text        NOT NULL DEFAULT 'America/Sao_Paulo',
  pausado_em  timestamptz,
  pausado_por text
);

INSERT INTO infoprice.ctl_agendamento (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Watermark ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_watermark (
  fonte          text        PRIMARY KEY,
  data_run       date        NOT NULL,
  id_execucao    bigint      REFERENCES infoprice.ctl_execucao (id) ON DELETE SET NULL,
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

-- ── Dimensão de lojas ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.dim_loja (
  id_loja  text PRIMARY KEY,
  rede     text,
  nome     text,
  uf       text,
  cidade   text,
  ativa    boolean NOT NULL DEFAULT true
);

-- ── Staging ─────────────────────────────────────────────────────────────────
-- Espelho fiel do arquivo recebido. Tudo entra como texto: a conversão de tipo
-- acontece nas regras de qualidade, para que uma linha malformada vire uma
-- rejeição rastreável em vez de derrubar o COPY inteiro.

CREATE TABLE IF NOT EXISTS infoprice.stg_isa_infopanel_preco (
  id_execucao        bigint  NOT NULL,
  id_arquivo         bigint  NOT NULL,
  arquivo            text    NOT NULL,
  numero_linha       bigint  NOT NULL,
  run_date           date    NOT NULL,
  gtin               text,
  descricao          text,
  id_loja            text,
  rede               text,
  uf                 text,
  municipio          text,
  preco              text,
  preco_promocional  text,
  tipo_preco         text,
  data_coleta        text,
  fonte              text,
  payload            text    NOT NULL
);

COMMENT ON TABLE infoprice.stg_isa_infopanel_preco IS
  'Espelho do arquivo recebido, apagado e recarregado por run.';

CREATE INDEX IF NOT EXISTS ix_stg_execucao ON infoprice.stg_isa_infopanel_preco (id_execucao);
CREATE INDEX IF NOT EXISTS ix_stg_run_date ON infoprice.stg_isa_infopanel_preco (run_date);

-- ── Fato ────────────────────────────────────────────────────────────────────
-- Particionado por mês em data_coleta. A chave de conflito
-- (gtin, id_loja, data_coleta, fonte) inclui a coluna de partição, exigência do
-- PostgreSQL para índices únicos em tabelas particionadas.

CREATE TABLE IF NOT EXISTS infoprice.fact_preco_coletado (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  gtin               text        NOT NULL,
  id_loja            text        NOT NULL,
  data_coleta        date        NOT NULL,
  fonte              text        NOT NULL,
  descricao          text,
  rede               text,
  uf                 text,
  municipio          text,
  preco              numeric(12, 2) NOT NULL,
  preco_promocional  numeric(12, 2),
  tipo_preco         text        NOT NULL DEFAULT 'Regular',
  id_execucao        bigint      NOT NULL,
  id_arquivo         bigint      NOT NULL,
  numero_linha       bigint      NOT NULL,
  criado_em          timestamptz NOT NULL DEFAULT now(),
  atualizado_em      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gtin, id_loja, data_coleta, fonte)
) PARTITION BY RANGE (data_coleta);

COMMENT ON TABLE infoprice.fact_preco_coletado IS
  'Dado final de preço, com id_execucao e id_arquivo em cada linha.';

CREATE INDEX IF NOT EXISTS ix_fato_execucao ON infoprice.fact_preco_coletado (id_execucao);
CREATE INDEX IF NOT EXISTS ix_fato_arquivo  ON infoprice.fact_preco_coletado (id_arquivo);
CREATE INDEX IF NOT EXISTS ix_fato_data_uf  ON infoprice.fact_preco_coletado (data_coleta, uf);
CREATE INDEX IF NOT EXISTS ix_fato_id       ON infoprice.fact_preco_coletado (id);

-- Cria a partição mensal que cobre a data informada, se ainda não existir.
CREATE OR REPLACE FUNCTION infoprice.garantir_particao(p_data date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_inicio date := date_trunc('month', p_data)::date;
  v_fim    date := (date_trunc('month', p_data) + interval '1 month')::date;
  v_nome   text := format('fact_preco_coletado_%s', to_char(v_inicio, 'YYYY_MM'));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'infoprice' AND c.relname = v_nome
  ) THEN
    EXECUTE format(
      'CREATE TABLE infoprice.%I PARTITION OF infoprice.fact_preco_coletado FOR VALUES FROM (%L) TO (%L)',
      v_nome, v_inicio, v_fim
    );
  END IF;
  RETURN v_nome;
END;
$$;

-- ── Validação de GTIN ───────────────────────────────────────────────────────
-- Dígito verificador módulo 10 (GS1). Aceita GTIN-8, 12, 13 e 14; qualquer
-- outro comprimento, caractere não numérico ou dígito divergente é inválido.

CREATE OR REPLACE FUNCTION infoprice.gtin_valido(p_gtin text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_limpo text;
  v_tam   integer;
  v_soma  integer := 0;
  v_peso  integer;
  v_dig   integer;
  i       integer;
BEGIN
  IF p_gtin IS NULL THEN
    RETURN false;
  END IF;

  v_limpo := btrim(p_gtin);

  IF v_limpo !~ '^[0-9]+$' THEN
    RETURN false;
  END IF;

  v_tam := length(v_limpo);
  IF v_tam NOT IN (8, 12, 13, 14) THEN
    RETURN false;
  END IF;

  -- Da direita para a esquerda, ignorando o dígito verificador, os pesos
  -- alternam 3 e 1 começando pelo 3.
  FOR i IN 1 .. v_tam - 1 LOOP
    v_peso := CASE WHEN (v_tam - i) % 2 = 1 THEN 3 ELSE 1 END;
    v_soma := v_soma + (substr(v_limpo, i, 1)::integer * v_peso);
  END LOOP;

  v_dig := (10 - (v_soma % 10)) % 10;
  RETURN v_dig = substr(v_limpo, v_tam, 1)::integer;
END;
$$;

-- Converte texto em numeric aceitando vírgula decimal; devolve NULL quando o
-- valor não é um número, para a regra de qualidade tratar como rejeição.
CREATE OR REPLACE FUNCTION infoprice.para_numero(p_valor text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text;
BEGIN
  IF p_valor IS NULL THEN RETURN NULL; END IF;
  v := btrim(p_valor);
  IF v = '' THEN RETURN NULL; END IF;
  -- "1.234,56" → "1234.56" ; "1234.56" permanece
  IF v ~ ',' THEN
    v := replace(replace(v, '.', ''), ',', '.');
  END IF;
  IF v !~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN NULL; END IF;
  RETURN v::numeric;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;

-- Converte texto em date aceitando ISO e dd/mm/aaaa; NULL quando não converte.
CREATE OR REPLACE FUNCTION infoprice.para_data(p_valor text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v text;
BEGIN
  IF p_valor IS NULL THEN RETURN NULL; END IF;
  v := btrim(p_valor);
  IF v = '' THEN RETURN NULL; END IF;
  IF v ~ '^\d{4}-\d{2}-\d{2}' THEN
    RETURN substr(v, 1, 10)::date;
  ELSIF v ~ '^\d{2}/\d{2}/\d{4}$' THEN
    RETURN to_date(v, 'DD/MM/YYYY');
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
