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

/** As 44 colunas do arquivo da InfoPrice (ISA-InfoPanel), na ordem. */
const CABECALHO = [
  'data_preco', 'origem_preco', 'uf', 'regiao', 'cidade', 'rede', 'tipo_loja',
  'loja', 'cnpj', 'cep', 'logradouro', 'numero_logradouro', 'complemento',
  'bairro', 'categoria', 'secao', 'descricao', 'conteudo_qtd',
  'conteudo_unidade', 'conteudo_descricao', 'conteudo_qtd_padronizada',
  'conteudo_unidade_padronizada', 'gtin', 'id_produto', 'id_loja',
  'tipo_produto', 'tipo_promocao', 'flag_promocao', 'latitude', 'longitude',
  'fabricante', 'cnpj_fabricante', 'marca_propria', 'preco_pago',
  'preco_regular', 'preco_unidade_padrao', 'valor_promocao', 'anuncio_flag',
  'anuncio_campanha', 'anuncio_mecanica', 'anuncio_mecanica_detalhe',
  'anuncio_grupo_de_midia', 'anuncio_midia', 'fonte_digital',
];

/** Delimitador e marcador de nulo, como o Spark grava. */
const DELIM = '|';
const NULO = '\\N';

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

/** [loja, rede, uf, cidade, região, tipo de loja, cnpj] */
const LOJAS = [
  ['STOK_CENTER-5111625', 'STOK CENTER', 'RS', 'TORRES', 'Sul', 'HIPERMERCADO', '92016757009148'],
  ['SUPER MUFFATO-440736', 'SUPER MUFFATO', 'PR', 'PARANAVAÍ', 'Sul', 'SUPERMERCADO', '76430438006102'],
  ['PAO_DE_ACUCAR-1042', 'PÃO DE AÇÚCAR', 'SP', 'SÃO PAULO', 'Sudeste', 'SUPERMERCADO', '47508411000156'],
  ['ASSAI-388', 'ASSAÍ', 'SP', 'CAMPINAS', 'Sudeste', 'ATACAREJO', '06057223000171'],
  ['GUANABARA-1120', 'GUANABARA', 'RJ', 'RIO DE JANEIRO', 'Sudeste', 'SUPERMERCADO', '33171637000150'],
  ['BH-2204', 'SUPERMERCADOS BH', 'MG', 'BELO HORIZONTE', 'Sudeste', 'SUPERMERCADO', '04641376000136'],
  ['ZAFFARI-9017', 'ZAFFARI', 'RS', 'PORTO ALEGRE', 'Sul', 'HIPERMERCADO', '93015006000113'],
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

function campo(valor: string | number | null): string {
  if (valor === null || valor === '') return NULO;
  const s = String(valor);
  return s.includes(DELIM) || s.includes('"')
    ? `"${s.replace(/"/g, '\\"')}"`
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
  yield CABECALHO.join(DELIM) + '\n';

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
    let idLoja: string | null = loja[0] as string;
    // Variação de ±12% no preço, para o merge ter o que atualizar entre runs.
    let preco = (produto.precoBase * (0.88 + rnd() * 0.24)).toFixed(2);
    // O arquivo traz o último preço visto de cada produto em cada loja, então
    // as datas se espalham pelos últimos 90 dias. A data depende só da posição
    // da linha, não da semente: regerar com --semente muda o preço da mesma
    // chave, o que exercita o caminho de atualização do merge.
    let dataColeta = somarDias(runDate, -(global % 90));
    const promocao = rnd() < 0.18;

    // ── Defeitos semeados, um por regra de qualidade ──────────────────────
    // No total ~0,32% das linhas, abaixo do limite de 0,5% que abre incidente:
    // assim o dia normal fica limpo e a regra de rejeições só dispara quando
    // um arquivo realmente vem pior que o habitual.
    const sorteio = rnd();
    let descricaoBruta: string | null = null;
    if (sorteio < 0.001) {
      gtin = '78912345678999'; // dígito verificador inválido
    } else if (sorteio < 0.0016) {
      preco = '0.00'; // preço menor ou igual a zero
    } else if (sorteio < 0.0022) {
      idLoja = null; // linha sem loja
    } else if (sorteio < 0.0026) {
      dataColeta = somarDias(runDate, 3); // data posterior ao run
    } else if (sorteio < 0.0029) {
      descricao = descricao.replace('É', '\\xC9'); // encoding quebrado
      if (!descricao.includes('\\x')) descricao = `CAF\\xC9 ${descricao}`;
    } else if (sorteio < 0.0032) {
      // Linha que não tem como ser lida: aspa solta seguida de texto e de um
      // delimitador a mais. Vira rejeição sem interromper o arquivo.
      descricaoBruta = `"${descricao}"x${DELIM}sobra`;
    } else if (sorteio < 0.0034) {
      // Não é defeito: aspa escapada com barra, como o Spark grava por padrão.
      // O leitor precisa aceitar a linha normalmente.
      descricaoBruta = `"${descricao} TV 50\\" LED"`;
    }

    const precoPago = promocao ? (Number(preco) * 0.82).toFixed(2) : preco;
    const linha: (string | number | null)[] = [
      dataColeta, 'App/Sites proprios', loja[2]!, loja[4]!, loja[3]!, loja[1]!,
      loja[5]!, idLoja, loja[6]!, '95560000', 'RUA EXEMPLO', '100', null,
      'CENTRO', produto.categoria.toUpperCase(), 'MERCEARIA', descricao,
      '1.0', 'UN', '1UN', '1.0', 'UN', gtin, null, null, 'GTIN',
      promocao ? 'DESCONTO' : null, promocao ? 'true' : 'false',
      '-29.3383976', '-49.728226', produto.marca, '14049467000130', 'false',
      precoPago, preco, preco,
      promocao ? (Number(preco) - Number(precoPago)).toFixed(2) : '0.00',
      null, null, null, null, null, null, 'fixture',
    ];

    const celulas = linha.map(campo);
    if (descricaoBruta) celulas[CABECALHO.indexOf('descricao')] = descricaoBruta;
    yield celulas.join(DELIM) + '\n';
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
