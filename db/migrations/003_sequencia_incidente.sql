-- ─────────────────────────────────────────────────────────────────────────────
-- 003 · Sequência própria para o código do incidente
--
-- O código (#217) é o identificador que as pessoas usam ao falar do incidente,
-- e aparece no e-mail e na tela. Mantê-lo numa sequência separada da chave
-- primária evita que os dois números se desencontrem a cada inserção.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE SEQUENCE IF NOT EXISTS infoprice.ctl_incidente_codigo_seq START WITH 201;

ALTER TABLE infoprice.ctl_incidente
  ALTER COLUMN codigo
  SET DEFAULT '#' || lpad(nextval('infoprice.ctl_incidente_codigo_seq')::text, 3, '0');
