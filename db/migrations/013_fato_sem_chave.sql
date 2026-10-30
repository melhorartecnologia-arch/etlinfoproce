-- ─────────────────────────────────────────────────────────────────────────────
-- 013 · Fato sem chave: inserção seca
--
-- A tabela final deixa de verificar o que recebe. Cada linha do arquivo entra
-- como veio, sem chave primária, sem UPSERT e sem NOT NULL nos dados:
--
-- - sem a chave (gtin, id_loja, data_coleta, fonte), o mesmo preço trazido
--   por arquivos de dias diferentes fica gravado uma vez por arquivo;
-- - reprocessar um arquivo continua seguro: a carga apaga as linhas que o
--   próprio arquivo gravou antes (ix_fato_arquivo) e grava de novo;
-- - preco e preco_promocional sem limite de casas: um valor grande não
--   derruba mais o arquivo. A troca de numeric(12,2) por numeric não reescreve
--   a tabela;
-- - a partição DEFAULT recebe a linha sem data legível ou com data fora das
--   partições mensais, em vez de recusá-la.
--
-- Ficam os índices que as telas usam: ix_fato_arquivo (reprocessamento e
-- linhagem) e ix_fato_data_uf (consulta de preços). ix_fato_id não servia a
-- nenhuma consulta (a busca é por id::text) e ix_fato_execucao só à linha de
-- exemplo da linhagem, que passa a usar ix_fato_arquivo.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE infoprice.fact_preco_coletado
  DROP CONSTRAINT IF EXISTS fact_preco_coletado_pkey;

ALTER TABLE infoprice.fact_preco_coletado
  ALTER COLUMN gtin        DROP NOT NULL,
  ALTER COLUMN id_loja     DROP NOT NULL,
  ALTER COLUMN data_coleta DROP NOT NULL,
  ALTER COLUMN fonte       DROP NOT NULL,
  ALTER COLUMN preco       DROP NOT NULL,
  ALTER COLUMN tipo_preco  DROP NOT NULL,
  ALTER COLUMN preco             TYPE numeric,
  ALTER COLUMN preco_promocional TYPE numeric;

DROP INDEX IF EXISTS infoprice.ix_fato_id;
DROP INDEX IF EXISTS infoprice.ix_fato_execucao;

CREATE TABLE IF NOT EXISTS infoprice.fact_preco_coletado_default
  PARTITION OF infoprice.fact_preco_coletado DEFAULT;

-- Com a partição DEFAULT, criar um mês que ela já tem linhas falharia (as
-- linhas teriam de mudar de partição). Nesse caso o mês segue na DEFAULT: a
-- carga não para, e a consulta só perde a poda por mês daquele período.
CREATE OR REPLACE FUNCTION infoprice.garantir_particao(p_data date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_inicio date := date_trunc('month', p_data)::date;
  v_fim    date := (date_trunc('month', p_data) + interval '1 month')::date;
  v_nome   text := format('fact_preco_coletado_%s', to_char(v_inicio, 'YYYY_MM'));
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'infoprice' AND c.relname = v_nome
  ) THEN
    RETURN v_nome;
  END IF;

  IF to_regclass('infoprice.fact_preco_coletado_default') IS NOT NULL AND EXISTS (
    SELECT 1 FROM infoprice.fact_preco_coletado_default
     WHERE data_coleta >= v_inicio AND data_coleta < v_fim
  ) THEN
    RETURN 'fact_preco_coletado_default';
  END IF;

  EXECUTE format(
    'CREATE TABLE infoprice.%I PARTITION OF infoprice.fact_preco_coletado FOR VALUES FROM (%L) TO (%L)',
    v_nome, v_inicio, v_fim
  );
  RETURN v_nome;
END;
$$;
