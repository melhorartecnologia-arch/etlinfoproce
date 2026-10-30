-- ─────────────────────────────────────────────────────────────────────────────
-- 014 · garantir_particao sem a partição DEFAULT
--
-- A versão da 013 citava fact_preco_coletado_default direto no corpo da
-- função. O plpgsql resolve o nome da tabela ao preparar a consulta, antes de
-- avaliar o to_regclass que a protegia: sem a DEFAULT (depois de "Zerar base",
-- que apaga todas as partições), toda coleta parava com
-- 'relation "infoprice.fact_preco_coletado_default" does not exist'.
--
-- Agora a consulta à DEFAULT é dinâmica e só roda quando ela existe. E a
-- DEFAULT é recriada aqui, caso já tenha sido apagada.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION infoprice.garantir_particao(p_data date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_inicio  date := date_trunc('month', p_data)::date;
  v_fim     date := (date_trunc('month', p_data) + interval '1 month')::date;
  v_nome    text := format('fact_preco_coletado_%s', to_char(v_inicio, 'YYYY_MM'));
  v_ocupado boolean := false;
BEGIN
  IF to_regclass(format('infoprice.%I', v_nome)) IS NOT NULL THEN
    RETURN v_nome;
  END IF;

  -- Com a DEFAULT já guardando linhas deste mês, criar a partição falharia
  -- (as linhas teriam de mudar de partição): o mês segue na DEFAULT.
  IF to_regclass('infoprice.fact_preco_coletado_default') IS NOT NULL THEN
    EXECUTE format(
      'SELECT EXISTS (SELECT 1 FROM infoprice.fact_preco_coletado_default
                       WHERE data_coleta >= %L AND data_coleta < %L)',
      v_inicio, v_fim
    ) INTO v_ocupado;
    IF v_ocupado THEN
      RETURN 'fact_preco_coletado_default';
    END IF;
  END IF;

  EXECUTE format(
    'CREATE TABLE infoprice.%I PARTITION OF infoprice.fact_preco_coletado FOR VALUES FROM (%L) TO (%L)',
    v_nome, v_inicio, v_fim
  );
  RETURN v_nome;
END;
$$;

CREATE TABLE IF NOT EXISTS infoprice.fact_preco_coletado_default
  PARTITION OF infoprice.fact_preco_coletado DEFAULT;
