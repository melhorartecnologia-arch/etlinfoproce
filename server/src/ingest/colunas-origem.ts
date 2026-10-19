/**
 * As colunas do arquivo da InfoPrice que vão para a tabela final além das que
 * o pipeline usa nas regras (gtin, descricao, loja, preço, data, rede, UF,
 * cidade). Com elas, todas as 44 colunas do arquivo têm lugar no fato.
 *
 * Este catálogo é a fonte única: dele saem as colunas do COPY para o staging
 * (tudo texto) e as expressões do merge, que convertem cada valor para o tipo
 * do fato. A migração 011 cria as mesmas colunas — ao acrescentar uma coluna
 * aqui, crie também a migração que a adiciona.
 */

export type TipoColuna = 'texto' | 'numero' | 'booleano';

export interface ColunaOrigem {
  /** Nome da coluna no staging e no fato. */
  nome: string;
  /** Nome da coluna no arquivo, já normalizado (minúsculas, sem acento). */
  origem: string;
  tipo: TipoColuna;
}

const c = (origem: string, tipo: TipoColuna = 'texto', nome = origem): ColunaOrigem => ({
  nome,
  origem,
  tipo,
});

export const COLUNAS_ORIGEM: readonly ColunaOrigem[] = [
  c('origem_preco'),
  c('regiao'),
  c('tipo_loja'),
  // `loja` e `id_loja` do arquivo, como vieram. A chave do fato (id_loja) é a
  // loja e, na falta dela, o id_loja — ver leitor-csv.ts.
  c('loja'),
  c('id_loja', 'texto', 'id_loja_origem'),
  c('cnpj'),
  c('cep'),
  c('logradouro'),
  c('numero_logradouro'),
  c('complemento'),
  c('bairro'),
  c('categoria'),
  c('secao'),
  c('conteudo_qtd', 'numero'),
  c('conteudo_unidade'),
  c('conteudo_descricao'),
  c('conteudo_qtd_padronizada', 'numero'),
  c('conteudo_unidade_padronizada'),
  c('id_produto'),
  c('tipo_produto'),
  c('tipo_promocao'),
  c('flag_promocao', 'booleano'),
  c('latitude', 'numero'),
  c('longitude', 'numero'),
  c('fabricante'),
  c('cnpj_fabricante'),
  c('marca_propria', 'booleano'),
  c('preco_pago', 'numero'),
  c('preco_regular', 'numero'),
  c('preco_unidade_padrao', 'numero'),
  c('valor_promocao', 'numero'),
  c('anuncio_flag', 'booleano'),
  c('anuncio_campanha'),
  c('anuncio_mecanica'),
  c('anuncio_mecanica_detalhe'),
  c('anuncio_grupo_de_midia'),
  c('anuncio_midia'),
  c('fonte_digital'),
];

/**
 * Como o valor de texto do staging vira o tipo do fato. O que não converte
 * (um número ilegível) vira NULL: estas colunas são descritivas e não barram a
 * linha — o valor original continua no payload da carga.
 */
export function expressaoConversao(col: ColunaOrigem, alias = 's'): string {
  const ref = `${alias}.${col.nome}`;
  switch (col.tipo) {
    case 'numero':
      return `infoprice.para_numero(${ref})`;
    case 'booleano':
      return `infoprice.para_booleano(${ref})`;
    default:
      return `NULLIF(btrim(${ref}), '')`;
  }
}
