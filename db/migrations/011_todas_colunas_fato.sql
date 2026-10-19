-- ─────────────────────────────────────────────────────────────────────────────
-- 011 · Todas as colunas do arquivo na tabela final
--
-- O fato guardava só o que as regras usam (gtin, loja, data, preço, descrição,
-- rede, UF, cidade). As outras 38 colunas do arquivo ficavam apenas no payload
-- da carga. Agora cada uma tem coluna própria e tipada no fato, e uma coluna de
-- texto no staging, de onde o merge converte.
--
-- A lista é a mesma de server/src/ingest/colunas-origem.ts. As linhas já
-- gravadas ficam com estas colunas vazias até a data ser reprocessada: o merge
-- atualiza a linha quando qualquer coluna muda.
-- ─────────────────────────────────────────────────────────────────────────────

-- Sim/não tolerante: true/false, t/f, 1/0, s/n, sim/não, y/n, yes/no.
-- O que não for reconhecido vira NULL.
CREATE OR REPLACE FUNCTION infoprice.para_booleano(p_valor text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(btrim(p_valor))
    WHEN 'true'  THEN true  WHEN 't'   THEN true  WHEN '1' THEN true
    WHEN 's'     THEN true  WHEN 'sim' THEN true  WHEN 'y' THEN true  WHEN 'yes' THEN true
    WHEN 'false' THEN false WHEN 'f'   THEN false WHEN '0' THEN false
    WHEN 'n'     THEN false WHEN 'nao' THEN false WHEN 'não' THEN false WHEN 'no' THEN false
  END
$$;

ALTER TABLE infoprice.stg_isa_infopanel_preco
  ADD COLUMN IF NOT EXISTS origem_preco                 text,
  ADD COLUMN IF NOT EXISTS regiao                       text,
  ADD COLUMN IF NOT EXISTS tipo_loja                    text,
  ADD COLUMN IF NOT EXISTS loja                         text,
  ADD COLUMN IF NOT EXISTS id_loja_origem               text,
  ADD COLUMN IF NOT EXISTS cnpj                         text,
  ADD COLUMN IF NOT EXISTS cep                          text,
  ADD COLUMN IF NOT EXISTS logradouro                   text,
  ADD COLUMN IF NOT EXISTS numero_logradouro            text,
  ADD COLUMN IF NOT EXISTS complemento                  text,
  ADD COLUMN IF NOT EXISTS bairro                       text,
  ADD COLUMN IF NOT EXISTS categoria                    text,
  ADD COLUMN IF NOT EXISTS secao                        text,
  ADD COLUMN IF NOT EXISTS conteudo_qtd                 text,
  ADD COLUMN IF NOT EXISTS conteudo_unidade             text,
  ADD COLUMN IF NOT EXISTS conteudo_descricao           text,
  ADD COLUMN IF NOT EXISTS conteudo_qtd_padronizada     text,
  ADD COLUMN IF NOT EXISTS conteudo_unidade_padronizada text,
  ADD COLUMN IF NOT EXISTS id_produto                   text,
  ADD COLUMN IF NOT EXISTS tipo_produto                 text,
  ADD COLUMN IF NOT EXISTS tipo_promocao                text,
  ADD COLUMN IF NOT EXISTS flag_promocao                text,
  ADD COLUMN IF NOT EXISTS latitude                     text,
  ADD COLUMN IF NOT EXISTS longitude                    text,
  ADD COLUMN IF NOT EXISTS fabricante                   text,
  ADD COLUMN IF NOT EXISTS cnpj_fabricante              text,
  ADD COLUMN IF NOT EXISTS marca_propria                text,
  ADD COLUMN IF NOT EXISTS preco_pago                   text,
  ADD COLUMN IF NOT EXISTS preco_regular                text,
  ADD COLUMN IF NOT EXISTS preco_unidade_padrao         text,
  ADD COLUMN IF NOT EXISTS valor_promocao               text,
  ADD COLUMN IF NOT EXISTS anuncio_flag                 text,
  ADD COLUMN IF NOT EXISTS anuncio_campanha             text,
  ADD COLUMN IF NOT EXISTS anuncio_mecanica             text,
  ADD COLUMN IF NOT EXISTS anuncio_mecanica_detalhe     text,
  ADD COLUMN IF NOT EXISTS anuncio_grupo_de_midia       text,
  ADD COLUMN IF NOT EXISTS anuncio_midia                text,
  ADD COLUMN IF NOT EXISTS fonte_digital                text;

-- Na tabela particionada, a coluna nova vale para todas as partições. Sem
-- DEFAULT, o ALTER não reescreve as linhas existentes.
ALTER TABLE infoprice.fact_preco_coletado
  ADD COLUMN IF NOT EXISTS origem_preco                 text,
  ADD COLUMN IF NOT EXISTS regiao                       text,
  ADD COLUMN IF NOT EXISTS tipo_loja                    text,
  ADD COLUMN IF NOT EXISTS loja                         text,
  ADD COLUMN IF NOT EXISTS id_loja_origem               text,
  ADD COLUMN IF NOT EXISTS cnpj                         text,
  ADD COLUMN IF NOT EXISTS cep                          text,
  ADD COLUMN IF NOT EXISTS logradouro                   text,
  ADD COLUMN IF NOT EXISTS numero_logradouro            text,
  ADD COLUMN IF NOT EXISTS complemento                  text,
  ADD COLUMN IF NOT EXISTS bairro                       text,
  ADD COLUMN IF NOT EXISTS categoria                    text,
  ADD COLUMN IF NOT EXISTS secao                        text,
  ADD COLUMN IF NOT EXISTS conteudo_qtd                 numeric,
  ADD COLUMN IF NOT EXISTS conteudo_unidade             text,
  ADD COLUMN IF NOT EXISTS conteudo_descricao           text,
  ADD COLUMN IF NOT EXISTS conteudo_qtd_padronizada     numeric,
  ADD COLUMN IF NOT EXISTS conteudo_unidade_padronizada text,
  ADD COLUMN IF NOT EXISTS id_produto                   text,
  ADD COLUMN IF NOT EXISTS tipo_produto                 text,
  ADD COLUMN IF NOT EXISTS tipo_promocao                text,
  ADD COLUMN IF NOT EXISTS flag_promocao                boolean,
  ADD COLUMN IF NOT EXISTS latitude                     numeric,
  ADD COLUMN IF NOT EXISTS longitude                    numeric,
  ADD COLUMN IF NOT EXISTS fabricante                   text,
  ADD COLUMN IF NOT EXISTS cnpj_fabricante              text,
  ADD COLUMN IF NOT EXISTS marca_propria                boolean,
  ADD COLUMN IF NOT EXISTS preco_pago                   numeric,
  ADD COLUMN IF NOT EXISTS preco_regular                numeric,
  ADD COLUMN IF NOT EXISTS preco_unidade_padrao         numeric,
  ADD COLUMN IF NOT EXISTS valor_promocao               numeric,
  ADD COLUMN IF NOT EXISTS anuncio_flag                 boolean,
  ADD COLUMN IF NOT EXISTS anuncio_campanha             text,
  ADD COLUMN IF NOT EXISTS anuncio_mecanica             text,
  ADD COLUMN IF NOT EXISTS anuncio_mecanica_detalhe     text,
  ADD COLUMN IF NOT EXISTS anuncio_grupo_de_midia       text,
  ADD COLUMN IF NOT EXISTS anuncio_midia                text,
  ADD COLUMN IF NOT EXISTS fonte_digital                text;
