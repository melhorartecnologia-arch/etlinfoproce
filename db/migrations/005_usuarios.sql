-- ─────────────────────────────────────────────────────────────────────────────
-- 005 · Usuários, sessões e tentativas de login
--
-- Até aqui o console identificava o operador por um cabeçalho HTTP, o que
-- significa que qualquer cliente podia se declarar quem quisesse — e o nome
-- gravado em "resolvido_por" não valia como evidência. Esta migração troca isso
-- por autenticação de verdade.
--
-- Papéis:
--   leitor         vê as telas e exporta relatórios
--   operador       o acima, mais as seis ações de operação (coleta manual,
--                  reprocessar, pausar/retomar, resolver incidente, baixar)
--   administrador  o acima, mais a gestão de usuários
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_usuario (
  id                bigserial   PRIMARY KEY,
  login             text        NOT NULL,
  nome              text        NOT NULL,
  email             text,
  -- Formato: scrypt$N$r$p$salt_base64$hash_base64. O algoritmo e os parâmetros
  -- ficam junto do hash para que um custo maior possa ser adotado no futuro sem
  -- invalidar as senhas já cadastradas.
  senha_hash        text        NOT NULL,
  papel             text        NOT NULL DEFAULT 'leitor'
                      CHECK (papel IN ('administrador', 'operador', 'leitor')),
  ativo             boolean     NOT NULL DEFAULT true,
  -- Obriga a troca no primeiro acesso, para que uma senha definida por um
  -- administrador não permaneça conhecida por duas pessoas.
  trocar_senha      boolean     NOT NULL DEFAULT false,
  ultimo_acesso     timestamptz,
  senha_alterada_em timestamptz NOT NULL DEFAULT now(),
  criado_em         timestamptz NOT NULL DEFAULT now(),
  criado_por        bigint      REFERENCES infoprice.ctl_usuario (id) ON DELETE SET NULL,
  atualizado_em     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE infoprice.ctl_usuario IS
  'Quem pode entrar no console e o que cada um pode fazer.';

-- O login é case-insensitive: "Bruno.Ruiz" e "bruno.ruiz" são a mesma pessoa.
CREATE UNIQUE INDEX IF NOT EXISTS ux_usuario_login
  ON infoprice.ctl_usuario (lower(login));

CREATE INDEX IF NOT EXISTS ix_usuario_ativo ON infoprice.ctl_usuario (ativo);

-- ── Sessões ─────────────────────────────────────────────────────────────────
-- Sessão do lado do servidor, e não um token autocontido: assim desativar um
-- usuário ou clicar em "sair" encerra o acesso na hora, sem esperar expirar.

CREATE TABLE IF NOT EXISTS infoprice.ctl_sessao (
  id            bigserial   PRIMARY KEY,
  -- Guardamos o SHA-256 do token, nunca o token: um vazamento desta tabela não
  -- entrega sessões utilizáveis.
  token_hash    text        NOT NULL UNIQUE,
  id_usuario    bigint      NOT NULL REFERENCES infoprice.ctl_usuario (id) ON DELETE CASCADE,
  criada_em     timestamptz NOT NULL DEFAULT now(),
  expira_em     timestamptz NOT NULL,
  ultimo_uso    timestamptz NOT NULL DEFAULT now(),
  ip            text,
  agente        text,
  encerrada_em  timestamptz,
  motivo_fim    text
);

CREATE INDEX IF NOT EXISTS ix_sessao_usuario ON infoprice.ctl_sessao (id_usuario);
CREATE INDEX IF NOT EXISTS ix_sessao_expira  ON infoprice.ctl_sessao (expira_em)
  WHERE encerrada_em IS NULL;

-- ── Tentativas de login ─────────────────────────────────────────────────────
-- Serve a dois propósitos: travar ataque de força bruta e deixar registrado
-- quem tentou entrar e quando, que é a mesma exigência de rastreabilidade que
-- o resto da aplicação já cumpre.

CREATE TABLE IF NOT EXISTS infoprice.ctl_tentativa_login (
  id         bigserial   PRIMARY KEY,
  login      text        NOT NULL,
  ip         text,
  sucesso    boolean     NOT NULL,
  motivo     text,
  ocorrida_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_tentativa_login_recente
  ON infoprice.ctl_tentativa_login (lower(login), ocorrida_em DESC);
CREATE INDEX IF NOT EXISTS ix_tentativa_ip_recente
  ON infoprice.ctl_tentativa_login (ip, ocorrida_em DESC);

-- ── Autoria nas ações já existentes ─────────────────────────────────────────
-- O incidente já registrava "resolvido_por" como texto livre. Agora aponta para
-- o usuário de verdade, mantendo o texto para o histórico anterior à migração.

ALTER TABLE infoprice.ctl_incidente
  ADD COLUMN IF NOT EXISTS id_usuario_resolucao bigint
    REFERENCES infoprice.ctl_usuario (id) ON DELETE SET NULL;

-- Quem disparou a execução, quando veio da tela.
ALTER TABLE infoprice.ctl_execucao
  ADD COLUMN IF NOT EXISTS id_usuario bigint
    REFERENCES infoprice.ctl_usuario (id) ON DELETE SET NULL;

-- Quem pausou o agendamento.
ALTER TABLE infoprice.ctl_agendamento
  ADD COLUMN IF NOT EXISTS id_usuario_pausa bigint
    REFERENCES infoprice.ctl_usuario (id) ON DELETE SET NULL;
