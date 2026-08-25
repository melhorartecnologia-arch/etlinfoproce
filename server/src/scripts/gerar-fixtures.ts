/**
 * Gera arquivos csv.gz de exemplo no formato da InfoPrice, para rodar o
 * pipeline sem o servidor do fornecedor (SFTP_DRIVER=local).
 *
 * Uso:
 *   npm run gerar-fixtures --workspace server
 *   npm run gerar-fixtures --workspace server -- --dias 5 --arquivos 12 --linhas 40000
 *
 * Os defeitos são semeados de propósito, um por regra de qualidade, para que a
 * tela de rejeições tenha o que mostrar.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config } from '../config.js';
import { dataLocal, somarDias } from '../util/tempo.js';

interface Opcoes {
  dias: number;
  arquivos: number;
  linhas: number;
  ate: string;
  /** Desloca a semente: regerar com outro valor muda os preços do mesmo run,
   *  o que permite demonstrar o caminho de atualização do merge. */
  semente: number;
}

function lerOpcoes(): Opcoes {
  const args = process.argv.slice(2);
  const pegar = (nome: string, padrao: number) => {
    const i = args.indexOf(`--${nome}`);
    if (i === -1) return padrao;
    const v = Number(args[i + 1]);
    return Number.isFinite(v) ? v : padrao;
  };
  const iAte = args.indexOf('--ate');
  return {
    dias: pegar('dias', 6),
    arquivos: pegar('arquivos', 12),
    linhas: pegar('linhas', 8_000),
    ate: iAte === -1 ? dataLocal() : args[iAte + 1]!,
    semente: pegar('semente', 0),
  };
}

/** As 42 colunas do arquivo da InfoPrice. */
const CABECALHO = [
  'gtin', 'descricao', 'id_loja', 'rede', 'uf', 'municipio',
  'preco', 'preco_promocional', 'tipo_preco', 'data_coleta',
  'id_pesquisa', 'id_produto', 'categoria', 'subcategoria', 'marca',
  'fabricante', 'embalagem', 'quantidade', 'unidade_medida', 'ncm',
  'cest', 'origem_coleta', 'canal', 'tipo_loja', 'cnpj_loja',
  'endereco_loja', 'bairro', 'cep', 'latitude', 'longitude',
  'regiao', 'cluster_loja', 'promocao_inicio', 'promocao_fim',
  'preco_por_unidade', 'moeda', 'imposto_incluso', 'coletor',
  'metodo_coleta', 'confianca', 'observacao', 'versao_layout',
];

const PRODUTOS = [
  ['7891000315507', 'LEITE CONDENSADO 395G', 'Laticínios', 'MOÇA', 6.49],
  ['7896004400204', 'CAFÉ TORRADO E MOÍDO 500G', 'Mercearia', 'MELITTA', 18.9],
  ['7893500020103', 'ÓLEO DE SOJA 900ML', 'Mercearia', 'LIZA', 7.29],
  ['7896036098127', 'ARROZ TIPO 1 5KG', 'Mercearia', 'TIO JOÃO', 24.79],
  ['7891910000197', 'AÇÚCAR REFINADO 1KG', 'Mercearia', 'UNIÃO', 4.59],
  ['7622300336738', 'BISCOITO RECHEADO 130G', 'Biscoitos', 'OREO', 3.19],
  ['7894900011517', 'REFRIGERANTE COLA 2L', 'Bebidas', 'COCA-COLA', 8.99],
  ['7896110000283', 'PAPEL HIGIÊNICO 12 ROLOS', 'Higiene', 'NEVE', 27.9],
  ['7891149101504', 'FEIJÃO CARIOCA 1KG', 'Mercearia', 'CAMIL', 8.49],
  ['7896102502787', 'MACARRÃO ESPAGUETE 500G', 'Mercearia', 'RENATA', 4.99],
  ['7891991010856', 'CERVEJA PILSEN LATA 350ML', 'Bebidas', 'BRAHMA', 3.79],
  ['7896056801011', 'SABÃO EM PÓ 1KG', 'Limpeza', 'OMO', 16.49],
];

const LOJAS = [
  ['SP-8841', '1042', 'SP', 'São Paulo'],
  ['SP-1027', '388', 'SP', 'Campinas'],
  ['SP-3390', '1042', 'SP', 'Santo André'],
  ['SP-4415', '705', 'SP', 'Guarulhos'],
  ['RJ-1120', '388', 'RJ', 'Rio de Janeiro'],
  ['MG-2204', '705', 'MG', 'Belo Horizonte'],
  ['RS-9017', '1042', 'RS', 'Porto Alegre'],
];

const CATEGORIAS = [
  ['Mercearia', 'PACOTE 1KG'],
  ['Bebidas', 'GARRAFA 1L'],
  ['Laticínios', 'CAIXA 1L'],
  ['Limpeza', 'FRASCO 500ML'],
  ['Higiene', 'UNIDADE'],
  ['Biscoitos', 'PACOTE 200G'],
  ['Congelados', 'CAIXA 400G'],
  ['Hortifruti', 'KG'],
];

const MARCAS = [
  'PRIMOR', 'AURORA', 'BOA SAFRA', 'VALE VERDE', 'DONA CLARA',
  'SERRA AZUL', 'CAMPO BOM', 'SOL NASCENTE', 'VILA NOVA', 'BOM PRATO',
];

/** Dígito verificador GS1 (módulo 10) para uma base de 12 dígitos. */
function digitoGtin(base: string): number {
  let soma = 0;
  for (let i = 0; i < base.length; i += 1) {
    const peso = (base.length - i) % 2 === 1 ? 3 : 1;
    soma += Number(base[i]) * peso;
  }
  return (10 - (soma % 10)) % 10;
}

interface Produto {
  gtin: string;
  descricao: string;
  categoria: string;
  marca: string;
  precoBase: number;
}

/**
 * Catálogo determinístico com `quantidade` produtos.
 *
 * Os 12 primeiros são produtos reais reconhecíveis, para a tela de consulta de
 * preços mostrar nomes de verdade; o restante é sintético, com GTIN de dígito
 * verificador válido. O catálogo precisa ser grande o bastante para que
 * (gtin × loja) cubra todas as linhas do dia sem repetir a chave de conflito —
 * caso contrário a regra de duplicidade rejeitaria quase tudo.
 */
function montarCatalogo(quantidade: number): Produto[] {
  const catalogo: Produto[] = PRODUTOS.map((p) => ({
    gtin: p[0] as string,
    descricao: p[1] as string,
    categoria: p[2] as string,
    marca: p[3] as string,
    precoBase: p[4] as number,
  }));

  for (let i = catalogo.length; i < quantidade; i += 1) {
    const base = String(789_000_000_000 + i * 17).slice(0, 12);
    const gtin = base + String(digitoGtin(base));
    const [categoria, embalagem] = CATEGORIAS[i % CATEGORIAS.length]!;
    const marca = MARCAS[i % MARCAS.length]!;
    catalogo.push({
      gtin,
      descricao: `${marca} ${categoria.toUpperCase()} ${embalagem} ${i}`,
      categoria: categoria!,
      marca,
      // Faixa de R$ 2,50 a R$ 52,50, estável por produto.
      precoBase: 2.5 + ((i * 37) % 500) / 10,
    });
  }

  return catalogo;
}

/** Gerador determinístico: a mesma semente sempre produz o mesmo arquivo. */
function aleatorio(semente: number): () => number {
  let s = semente >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function campo(valor: string | number): string {
  const s = String(valor);
  return s.includes(';') || s.includes('"')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function* gerarLinhas(
  runDate: string,
  indiceArquivo: number,
  quantidade: number,
  catalogo: Produto[],
  deslocamento: number,
  semente: number,
): Generator<string> {
  yield CABECALHO.join(';') + '\n';

  const rnd = aleatorio(
    Number(runDate.replace(/-/g, '')) + indiceArquivo * 7919 + semente * 104_729,
  );

  for (let i = 0; i < quantidade; i += 1) {
    // Cada linha do dia recebe um par (produto, loja) distinto: o índice global
    // varre o catálogo e só então avança de loja.
    const global = deslocamento + i;
    const produto = catalogo[global % catalogo.length]!;
    const loja =
      LOJAS[Math.floor(global / catalogo.length) % LOJAS.length]!;

    let gtin = produto.gtin;
    let descricao = produto.descricao;
    let idLoja = loja[0] as string;
    // Variação de ±12% no preço, para o merge ter o que atualizar entre runs.
    let preco = (produto.precoBase * (0.88 + rnd() * 0.24)).toFixed(2);
    let dataColeta = runDate;
    const promocao = rnd() < 0.18;

    // ── Defeitos semeados, um por regra de qualidade ──────────────────────
    // No total ~0,29% das linhas, abaixo do limite de 0,5% que abre incidente:
    // assim o dia normal fica limpo e a regra de rejeições só dispara quando
    // um arquivo realmente vem pior que o habitual.
    const sorteio = rnd();
    if (sorteio < 0.001) {
      gtin = '78912345678999'; // dígito verificador inválido
    } else if (sorteio < 0.0016) {
      preco = '0.00'; // preço menor ou igual a zero
    } else if (sorteio < 0.0022) {
      idLoja = `SP-${9000 + Math.floor(rnd() * 900)}`; // loja fora de dim_loja
    } else if (sorteio < 0.0026) {
      dataColeta = somarDias(runDate, -30); // fora da janela do run
    } else if (sorteio < 0.0029) {
      descricao = descricao.replace('É', '\\xC9'); // encoding quebrado
      if (!descricao.includes('\\x')) descricao = `CAF\\xC9 ${descricao}`;
    }

    const precoPromo = promocao ? (Number(preco) * 0.82).toFixed(2) : '';
    const linha = [
      gtin, descricao, idLoja, loja[1], loja[2], loja[3],
      preco, precoPromo, promocao ? 'Promoção' : 'Regular', dataColeta,
      `PSQ-${runDate.replace(/-/g, '')}`, `PRD-${gtin.slice(-6)}`,
      produto.categoria, 'Geral', produto.marca, produto.marca, 'UN', '1', 'UN',
      '00000000', '0000000', 'SFTP', 'Autosserviço', 'Supermercado',
      '00000000000191', 'Rua Exemplo, 100', 'Centro', '01001000',
      '-23.55', '-46.63', 'Sudeste', 'A', '', '',
      preco, 'BRL', 'S', 'coletor-automatico', 'sftp',
      (0.9 + rnd() * 0.1).toFixed(2), '', 'v1',
    ];

    yield linha.map(campo).join(';') + '\n';
  }
}

async function main(): Promise<void> {
  const opcoes = lerOpcoes();
  const base = config.sftp.diretorioLocal;

  console.log(`[fixtures] destino ${base}`);
  console.log(
    `[fixtures] ${opcoes.dias} dias · ${opcoes.arquivos} arquivos/dia · ` +
      `${opcoes.linhas.toLocaleString('pt-BR')} linhas/arquivo`,
  );

  // Um par (produto, loja) por linha do dia, sem repetir a chave de conflito.
  const linhasPorDia = opcoes.arquivos * opcoes.linhas;
  const catalogo = montarCatalogo(
    Math.max(PRODUTOS.length, Math.ceil(linhasPorDia / LOJAS.length)),
  );
  console.log(
    `[fixtures] catálogo de ${catalogo.length.toLocaleString('pt-BR')} produtos ` +
      `× ${LOJAS.length} lojas`,
  );

  for (let d = opcoes.dias - 1; d >= 0; d -= 1) {
    const runDate = somarDias(opcoes.ate, -d);
    const pasta = path.join(base, `run=${runDate}`);
    await fsp.mkdir(pasta, { recursive: true });

    for (let a = 0; a < opcoes.arquivos; a += 1) {
      const nome = `isa_infopanel_${runDate}_${String(a).padStart(3, '0')}.csv.gz`;
      const destino = path.join(pasta, nome);

      await pipeline(
        Readable.from(
          gerarLinhas(
            runDate,
            a,
            opcoes.linhas,
            catalogo,
            a * opcoes.linhas,
            opcoes.semente,
          ),
        ),
        zlib.createGzip({ level: 6 }),
        fs.createWriteStream(destino),
      );
    }

    console.log(`[fixtures] run=${runDate} · ${opcoes.arquivos} arquivos`);
  }

  console.log('[fixtures] pronto');
}

main().catch((erro) => {
  console.error('[fixtures]', erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
