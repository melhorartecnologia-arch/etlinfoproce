-- ─────────────────────────────────────────────────────────────────────────────
-- 009 · Parar uma coleta em andamento
--
-- batimento_em        a coleta grava "estou viva" a cada 30 s. Uma execução
--                     em_execucao sem batimento recente não tem processo por
--                     trás (servidor reiniciado, terminal fechado no meio): é
--                     órfã, e sem isto ficaria em andamento para sempre —
--                     bloqueando o reset e, pelo índice ux_execucao_em_andamento,
--                     toda coleta nova.
-- cancelamento_*      o pedido de parada fica no banco, e não só na memória:
--                     assim ele alcança também uma coleta rodando em outro
--                     processo (o comando ingest no terminal).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE infoprice.ctl_execucao
  ADD COLUMN IF NOT EXISTS batimento_em               timestamptz,
  ADD COLUMN IF NOT EXISTS cancelamento_solicitado_em timestamptz,
  ADD COLUMN IF NOT EXISTS cancelado_por              text;
