-- ─────────────────────────────────────────────────────────────────────────────
-- 006 · Linha malformada no arquivo vira rejeição, e não falha da execução
--
-- Uma linha que não pode ser separada em colunas (aspas desbalanceadas, por
-- exemplo) abortava a leitura do arquivo inteiro e, com ela, a execução. Agora
-- a linha entra no staging com o texto original no payload e o motivo nesta
-- coluna; a primeira regra de qualidade a rejeita para ctl_rejeicao.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE infoprice.stg_isa_infopanel_preco
  ADD COLUMN IF NOT EXISTS erro_leitura text;

COMMENT ON COLUMN infoprice.stg_isa_infopanel_preco.erro_leitura IS
  'Por que a linha não pôde ser separada em colunas; NULL quando foi lida normalmente.';
