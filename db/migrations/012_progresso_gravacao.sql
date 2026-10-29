-- ─────────────────────────────────────────────────────────────────────────────
-- 012 · Progresso da gravação no banco
--
-- Cada arquivo passa por staging, regras e merge numa transação que pode
-- levar minutos. Até aqui o log só ganhava uma linha quando o arquivo inteiro
-- era efetivado: entre "schema validado" e o primeiro "gravado" a tela ficava
-- muda, sem dizer se o banco estava trabalhando ou parado num lock.
--
-- progresso guarda onde a gravação está — arquivo, fase, linhas, pid do
-- backend do PostgreSQL e o último retrato de pg_stat_activity dele. A coleta
-- atualiza a coluna fora da transação de dados, então ela é visível na hora; e
-- fica depois do fim, para mostrar em que ponto uma execução parou.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE infoprice.ctl_execucao
  ADD COLUMN IF NOT EXISTS progresso jsonb;

COMMENT ON COLUMN infoprice.ctl_execucao.progresso IS
  'Arquivo e fase da gravação em curso, com o pid do backend e o último retrato de pg_stat_activity.';
