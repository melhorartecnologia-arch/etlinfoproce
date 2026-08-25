-- ─────────────────────────────────────────────────────────────────────────────
-- 004 · Separa o inventário do arquivo da sua participação em cada execução
--
-- ctl_arquivo responde "o que existe (ou existiu) na origem": um arquivo é
-- identificado por (pasta, nome) e tem um hash, um tamanho e um prazo de
-- retenção. Isso é estável entre execuções.
--
-- Quantas linhas aquele arquivo rendeu, porém, é uma propriedade da execução:
-- reprocessar o mesmo arquivo produz contagens novas sem apagar as antigas.
-- Sem esta tabela, o reprocessamento reatribuía o arquivo à execução mais
-- recente e as execuções anteriores perdiam o detalhe — justamente o que a tela
-- de rastreabilidade precisa mostrar.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS infoprice.ctl_execucao_arquivo (
  id                  bigserial PRIMARY KEY,
  id_execucao         bigint      NOT NULL REFERENCES infoprice.ctl_execucao (id) ON DELETE CASCADE,
  id_arquivo          bigint      NOT NULL REFERENCES infoprice.ctl_arquivo (id) ON DELETE CASCADE,
  baixado_em          timestamptz,
  ingerido_em         timestamptz,
  linhas_lidas        bigint      NOT NULL DEFAULT 0,
  linhas_gravadas     bigint      NOT NULL DEFAULT 0,
  linhas_rejeitadas   bigint      NOT NULL DEFAULT 0,
  linhas_inseridas    bigint      NOT NULL DEFAULT 0,
  linhas_atualizadas  bigint      NOT NULL DEFAULT 0,
  destino             text,
  status              text        NOT NULL DEFAULT 'visto'
                        CHECK (status IN ('visto', 'baixado', 'ingerido', 'rejeitado', 'erro')),
  erro                text,
  UNIQUE (id_execucao, id_arquivo)
);

COMMENT ON TABLE infoprice.ctl_execucao_arquivo IS
  'Participação de um arquivo numa execução: contagens e horários daquela passagem.';

CREATE INDEX IF NOT EXISTS ix_exec_arquivo_execucao
  ON infoprice.ctl_execucao_arquivo (id_execucao);
CREATE INDEX IF NOT EXISTS ix_exec_arquivo_arquivo
  ON infoprice.ctl_execucao_arquivo (id_arquivo);

-- Migra o que já existe: cada arquivo vira uma participação na sua execução.
INSERT INTO infoprice.ctl_execucao_arquivo
  (id_execucao, id_arquivo, baixado_em, ingerido_em, linhas_lidas,
   linhas_gravadas, linhas_rejeitadas, linhas_inseridas, linhas_atualizadas,
   destino, status)
SELECT a.id_execucao, a.id, a.baixado_em, a.ingerido_em, a.linhas_lidas,
       a.linhas_gravadas, a.linhas_rejeitadas, a.linhas_inseridas,
       a.linhas_atualizadas, a.destino,
       CASE WHEN a.status = 'arquivado' THEN 'ingerido' ELSE a.status END
  FROM infoprice.ctl_arquivo a
 WHERE a.id_execucao IS NOT NULL
ON CONFLICT (id_execucao, id_arquivo) DO NOTHING;

-- ctl_arquivo.id_execucao passa a significar "a última execução que tocou este
-- arquivo", útil para o inventário. As contagens saem daqui: quem pergunta
-- "quantas linhas?" está perguntando sobre uma execução.
COMMENT ON COLUMN infoprice.ctl_arquivo.id_execucao IS
  'Última execução que processou este arquivo; o histórico está em ctl_execucao_arquivo.';

ALTER TABLE infoprice.ctl_arquivo
  DROP COLUMN IF EXISTS linhas_lidas,
  DROP COLUMN IF EXISTS linhas_gravadas,
  DROP COLUMN IF EXISTS linhas_rejeitadas,
  DROP COLUMN IF EXISTS linhas_inseridas,
  DROP COLUMN IF EXISTS linhas_atualizadas,
  DROP COLUMN IF EXISTS destino;
