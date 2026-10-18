-- ─────────────────────────────────────────────────────────────────────────────
-- 007 · Índices para o processamento arquivo a arquivo
--
-- Cada arquivo agora passa sozinho por staging, regras, merge e commit. As
-- consultas dessas etapas filtram por (id_execucao, id_arquivo), e a limpeza do
-- staging antes da recarga filtra por id_arquivo. Sem estes índices, cada
-- arquivo varreria o staging inteiro da execução — com 50 arquivos de ~385 mil
-- linhas, o custo cresceria a cada arquivo processado.
--
-- As regras de qualidade e o merge também perguntam, linha a linha, se ela já
-- foi rejeitada: (id_execucao, arquivo, numero_linha) em ctl_rejeicao.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS ix_stg_arquivo_execucao
  ON infoprice.stg_isa_infopanel_preco (id_arquivo, id_execucao);

CREATE INDEX IF NOT EXISTS ix_rejeicao_linha
  ON infoprice.ctl_rejeicao (id_execucao, arquivo, numero_linha);
