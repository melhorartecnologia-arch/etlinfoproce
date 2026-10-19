-- ─────────────────────────────────────────────────────────────────────────────
-- 008 · Registro de quem zerou a base
--
-- Zerar a base apaga todo o histórico — execuções, arquivos, preços, rejeições,
-- incidentes, lojas e tentativas de acesso. Esta tabela fica de fora de
-- propósito: depois de um reset, ainda dá para saber quem o fez, quando, com
-- quais opções e quanto havia na base antes.
--
-- O autor é texto, e não chave para ctl_usuario: o reset pode apagar os
-- próprios usuários.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_reset (
  id                bigserial   PRIMARY KEY,
  executado_em      timestamptz NOT NULL DEFAULT now(),
  executado_por     text        NOT NULL,
  origem            text        NOT NULL CHECK (origem IN ('console', 'linha de comando')),
  incluiu_usuarios  boolean     NOT NULL DEFAULT false,
  apagou_arquivos   boolean     NOT NULL DEFAULT false,
  contagens         jsonb       NOT NULL
);

COMMENT ON TABLE infoprice.ctl_reset IS
  'Cada vez que a base foi zerada: quem, quando, opções e o que havia antes. Não é apagada pelo reset.';
