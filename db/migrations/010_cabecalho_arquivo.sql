-- ─────────────────────────────────────────────────────────────────────────────
-- 010 · Cabeçalho e delimitador de cada arquivo
--
-- A linha rejeitada é guardada como veio (ctl_rejeicao.payload). Com o
-- cabeçalho e o delimitador do arquivo dela, a tela de rejeições consegue
-- mostrar cada valor ao lado do nome da coluna e refazer a interpretação que a
-- carga fez — que é o que explica por que a linha foi barrada.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE infoprice.ctl_arquivo
  ADD COLUMN IF NOT EXISTS cabecalho   text,
  ADD COLUMN IF NOT EXISTS delimitador text;

COMMENT ON COLUMN infoprice.ctl_arquivo.cabecalho IS
  'Primeira linha do arquivo como veio; NULL quando o arquivo não tem cabeçalho (CSV_COLUNAS).';
