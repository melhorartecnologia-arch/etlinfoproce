-- ─────────────────────────────────────────────────────────────────────────────
-- 002 · Regras de notificação padrão
-- As mesmas seis regras que aparecem na tela "Alertas e incidentes".
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO infoprice.ctl_regra_alerta (chave, condicao, severidade, canal, destinatario, ordem) VALUES
  ('falha_execucao',   'Falha de conexão ou execução interrompida',        'Crítico',     'e-mail + painel', 'equipe-dados@', 1),
  ('pasta_ausente',    'Pasta do dia ausente na origem às 09:00',          'Crítico',     'e-mail + painel', 'equipe-dados@', 2),
  ('rejeicoes_altas',  'Rejeições acima de 0,5% das linhas do run',        'Atenção',     'e-mail',          'equipe-dados@', 3),
  ('desvio_volume',    'Volume fora de 25% da média dos últimos 7 dias',   'Atenção',     'e-mail',          'equipe-dados@', 4),
  ('arquivo_expirando','Arquivo a menos de 24h da expiração na origem',    'Informativo', 'painel',          '—',                5),
  ('resumo_diario',    'Resumo diário da execução às 06:00',               'Informativo', 'e-mail',          'equipe-dados@, bi@', 6)
ON CONFLICT (chave) DO NOTHING;
