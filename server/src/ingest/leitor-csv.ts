import fs from 'node:fs';
import zlib from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import { config } from '../config.js';

/**
 * Colunas que o pipeline usa do arquivo da InfoPrice. O arquivo traz 42
 * colunas; estas são as que alimentam staging e fato. As demais seguem
 * preservadas no campo `payload`, então nada se perde na rastreabilidade.
 */
export const COLUNAS_OBRIGATORIAS = [
  'gtin',
  'descricao',
  'id_loja',
  'preco',
  'data_coleta',
] as const;

/** Sinônimos aceitos no cabeçalho, para absorver variação da origem. */
const SINONIMOS: Record<string, string> = {
  ean: 'gtin',
  codigo_barras: 'gtin',
  cod_barras: 'gtin',
  produto: 'descricao',
  descricao_produto: 'descricao',
  nome_produto: 'descricao',
  loja: 'id_loja',
  codigo_loja: 'id_loja',
  cod_loja: 'id_loja',
  id_estabelecimento: 'id_loja',
  rede_loja: 'rede',
  bandeira: 'rede',
  estado: 'uf',
  sigla_uf: 'uf',
  cidade: 'municipio',
  valor: 'preco',
  preco_regular: 'preco',
  preco_venda: 'preco',
  valor_promocional: 'preco_promocional',
  preco_promo: 'preco_promocional',
  tipo: 'tipo_preco',
  tipo_de_preco: 'tipo_preco',
  data: 'data_coleta',
  dt_coleta: 'data_coleta',
  data_pesquisa: 'data_coleta',
};

/**
 * Quantas linhas físicas um campo entre aspas pode atravessar. Acima disso a
 * aspa de abertura é tratada como defeito da linha, e não como início de um
 * texto com quebras — sem esse teto, uma única aspa solta engoliria o resto
 * do arquivo como se fosse um campo só.
 */
const MAX_LINHAS_POR_REGISTRO = 50;

/** Teto do payload guardado para uma linha que não pôde ser lida. */
const MAX_PAYLOAD_MALFORMADO = 10_000;

const DELIMITADORES = [';', ',', '\t'] as const;

function limparNome(nome: string): string {
  return nome
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** MAPA_COLUNAS: nome no arquivo → coluna interna. Vale antes dos sinônimos. */
const MAPA_CONFIGURADO = new Map(
  config.coleta.mapaColunas
    .map((par) => par.split('='))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    .map(([interna, noArquivo]) => [limparNome(noArquivo), limparNome(interna)]),
);

export function normalizarCabecalho(nome: string): string {
  const limpo = limparNome(nome);
  return MAPA_CONFIGURADO.get(limpo) ?? SINONIMOS[limpo] ?? limpo;
}

export interface InfoCabecalho {
  delimitador: string;
  /** Nomes já normalizados e mapeados para o vocabulário interno. */
  colunas: string[];
  /** A primeira linha como veio, para o diagnóstico. */
  primeiraLinha: string;
  /** Os nomes vieram de CSV_COLUNAS: a primeira linha do arquivo é dado. */
  semCabecalho: boolean;
  /** A primeira linha tem cara de dado (GTIN, data, número) e não de nomes. */
  pareceDado: boolean;
}

const PADROES_DADO = [
  /^\d{8,14}$/, // GTIN
  /^\d{4}-\d{2}-\d{2}/, // data ISO
  /^\d{2}\/\d{2}\/\d{4}$/, // data dd/mm/aaaa
  /^-?\d+[.,]\d+$/, // número decimal
];

/** Interpreta a primeira linha não vazia do arquivo. */
export function analisarCabecalho(linha: string): InfoCabecalho {
  const primeiraLinha = linha.replace(/^\uFEFF/, '');
  const delimitador = detectarDelimitador(primeiraLinha);
  const campos = analisarRegistro(primeiraLinha, delimitador).campos;
  const semCabecalho = config.coleta.colunasPosicao.length > 0;
  return {
    delimitador,
    colunas: (semCabecalho ? config.coleta.colunasPosicao : campos).map(
      normalizarCabecalho,
    ),
    primeiraLinha,
    semCabecalho,
    pareceDado: campos.some((c) => PADROES_DADO.some((p) => p.test(c.trim()))),
  };
}

export interface RecusaCabecalho {
  /** O que falta e como resolver — igual para arquivos com o mesmo defeito. */
  motivo: string;
  /** A primeira linha do arquivo, para quem for corrigir ver o que chegou. */
  amostra: string;
}

/**
 * Confere se o cabeçalho traz as colunas obrigatórias. Devolve o motivo da
 * recusa e o que foi encontrado, ou null quando está tudo certo.
 */
export function validarCabecalho(info: InfoCabecalho): RecusaCabecalho | null {
  const faltando = COLUNAS_OBRIGATORIAS.filter((c) => !info.colunas.includes(c));
  if (faltando.length === 0) return null;

  const partes = [`sem ${faltando.join(', ')}`];
  if (info.pareceDado && !info.semCabecalho) {
    partes.push(
      'a primeira linha parece ser dado e não cabeçalho — se o arquivo não tem ' +
        'cabeçalho, informe os nomes das colunas na ordem em CSV_COLUNAS',
    );
  } else {
    partes.push(
      'se os nomes do arquivo são outros, mapeie em MAPA_COLUNAS ' +
        '(ex.: gtin=nome_no_arquivo)',
    );
  }
  const tab = info.delimitador === '\t' ? 'tab' : info.delimitador;
  return {
    motivo: partes.join(' · '),
    amostra:
      `primeira linha (${info.colunas.length} colunas, delimitador "${tab}"): ` +
      info.primeiraLinha.slice(0, 500),
  };
}

/** Lê só a primeira linha não vazia do arquivo, sem descompactar o resto. */
export async function lerCabecalho(caminho: string): Promise<InfoCabecalho> {
  const entrada = fs.createReadStream(caminho);
  const bytes = caminho.endsWith('.gz')
    ? entrada.pipe(zlib.createGunzip())
    : entrada;
  entrada.on('error', (erro) => bytes.destroy(erro));
  try {
    for await (const linha of linhasFisicas(bytes)) {
      if (linha.replace(/^\uFEFF/, '').trim() !== '') return analisarCabecalho(linha);
    }
    throw new Error('arquivo vazio');
  } finally {
    entrada.destroy();
    bytes.destroy();
  }
}

/** As primeiras linhas não vazias do arquivo, como vieram (para diagnóstico). */
export async function primeirasLinhas(caminho: string, quantidade: number): Promise<string[]> {
  const entrada = fs.createReadStream(caminho);
  const bytes = caminho.endsWith('.gz')
    ? entrada.pipe(zlib.createGunzip())
    : entrada;
  entrada.on('error', (erro) => bytes.destroy(erro));
  const linhas: string[] = [];
  try {
    for await (const linha of linhasFisicas(bytes)) {
      if (linha.trim() === '') continue;
      linhas.push(linha);
      if (linhas.length >= quantidade) break;
    }
    return linhas;
  } finally {
    entrada.destroy();
    bytes.destroy();
  }
}

export interface LinhaLida {
  numeroLinha: number;
  campos: Record<string, string>;
  payload: string;
  /**
   * Preenchido quando a linha não pôde ser separada em colunas. Ela segue para
   * o staging assim mesmo, com o texto original no payload, e a primeira regra
   * de qualidade a rejeita — um defeito de uma linha não derruba o arquivo.
   */
  erro?: string;
}

export interface ResultadoLeitura {
  cabecalho: string[];
  totalColunas: number;
  linhas: number;
  /** Linhas com aspas fora do padrão que ainda assim foram lidas. */
  recuperadas: number;
  /** Linhas que não puderam ser lidas e seguem como rejeição. */
  malformadas: number;
}

interface Registro {
  campos: string[];
  /** O texto terminou fora de aspas: o registro está inteiro. */
  completo: boolean;
  /** Apareceu aspa que nem fecha o campo nem está escapada. */
  irregular: boolean;
}

/** Só espaço (e tab, quando não é o delimitador) até o delimitador ou o fim? */
function fechaCampo(texto: string, pos: number, delim: string): boolean {
  let i = pos;
  while (i < texto.length && texto[i] !== delim && (texto[i] === ' ' || texto[i] === '\t')) {
    i += 1;
  }
  return i >= texto.length || texto[i] === delim;
}

/**
 * Separa um registro em campos, de forma tolerante.
 *
 * Dentro de aspas aceita os dois escapes que aparecem na prática: `""` (RFC
 * 4180) e `\"` (o padrão do Spark, que gera os arquivos da InfoPrice). Uma aspa
 * que não fecha o campo — seguida de texto, e não do delimitador — vira parte
 * do valor e marca o registro como irregular, em vez de abortar a leitura.
 */
function analisarRegistro(texto: string, delim: string): Registro {
  const campos: string[] = [];
  let irregular = false;
  let i = 0;
  const n = texto.length;

  for (;;) {
    let j = i;
    while (j < n && texto[j] !== delim && (texto[j] === ' ' || texto[j] === '\t')) j += 1;

    if (j < n && texto[j] === '"') {
      let valor = '';
      let k = j + 1;
      let fechado = false;

      while (k < n) {
        const c = texto[k]!;
        if (c === '\\' && texto[k + 1] === '"') {
          // `\"` é escape, a menos que essa aspa feche o campo: aí a barra é
          // literal (um valor que termina em barra, como "C:\").
          if (!fechaCampo(texto, k + 2, delim)) {
            valor += '"';
            k += 2;
            continue;
          }
          valor += '\\';
          k += 1;
          continue;
        }
        if (c === '"') {
          if (texto[k + 1] === '"') {
            valor += '"';
            k += 2;
            continue;
          }
          if (fechaCampo(texto, k + 1, delim)) {
            fechado = true;
            k += 1;
            break;
          }
          irregular = true;
          valor += '"';
          k += 1;
          continue;
        }
        valor += c;
        k += 1;
      }

      if (!fechado) return { campos, completo: false, irregular };

      campos.push(valor);
      while (k < n && texto[k] !== delim) k += 1;
      if (k >= n) return { campos, completo: true, irregular };
      i = k + 1;
    } else {
      const fim = texto.indexOf(delim, i);
      campos.push((fim === -1 ? texto.slice(i) : texto.slice(i, fim)).trim());
      if (fim === -1) return { campos, completo: true, irregular };
      i = fim + 1;
    }
  }
}

/** Remove as aspas externas de um campo e desfaz os escapes. */
function desaspar(campo: string): string {
  const t = campo.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/""/g, '"').replace(/\\"/g, '"');
  }
  return t;
}

/** O delimitador mais frequente fora de aspas no cabeçalho; `;` se nenhum. */
function detectarDelimitador(cabecalho: string): string {
  const contagem = new Map<string, number>(DELIMITADORES.map((d) => [d, 0]));
  let entreAspas = false;
  for (const c of cabecalho) {
    if (c === '"') entreAspas = !entreAspas;
    else if (!entreAspas && contagem.has(c)) contagem.set(c, contagem.get(c)! + 1);
  }
  let melhor: string = ';';
  for (const [d, q] of contagem) if (q > contagem.get(melhor)!) melhor = d;
  return melhor;
}

/**
 * Linhas físicas do arquivo, sem o terminador. O PostgreSQL recusa o byte nulo
 * num campo texto — derrubaria o COPY do arquivo inteiro —, então ele é trocado
 * pelo caractere de substituição, que a regra de encoding já reconhece.
 */
async function* linhasFisicas(
  entrada: NodeJS.ReadableStream,
): AsyncGenerator<string> {
  const decodificador = new StringDecoder('utf8');
  let resto = '';
  const limpar = (l: string) =>
    (l.endsWith('\r') ? l.slice(0, -1) : l).replace(/\u0000/g, '\uFFFD');

  for await (const pedaco of entrada) {
    resto += decodificador.write(pedaco as Buffer);
    let inicio = 0;
    let fim: number;
    while ((fim = resto.indexOf('\n', inicio)) !== -1) {
      yield limpar(resto.slice(inicio, fim));
      inicio = fim + 1;
    }
    resto = resto.slice(inicio);
  }

  resto += decodificador.end();
  if (resto.length > 0) yield limpar(resto);
}

/**
 * Lê um .csv.gz (ou .csv) e entrega as linhas em lotes.
 *
 * O arquivo é processado em streaming: um arquivo de 160 MB comprimido nunca
 * é materializado inteiro em memória. O `for await` aplica contrapressão, então
 * a leitura anda no ritmo do COPY para o banco.
 *
 * A leitura não aborta por causa de uma linha: aspas fora do padrão são
 * interpretadas de forma tolerante e, quando a linha não tem como ser separada
 * em colunas, ela segue marcada com `erro` para virar rejeição rastreável.
 */
export async function lerCsv(
  caminho: string,
  aoLote: (lote: LinhaLida[]) => Promise<void>,
  tamanhoLote = 5_000,
): Promise<ResultadoLeitura> {
  const entrada = fs.createReadStream(caminho);
  const bytes = caminho.endsWith('.gz')
    ? entrada.pipe(zlib.createGunzip())
    : entrada;
  // O pipe não repassa erros: sem isto, um gzip corrompido deixaria a
  // leitura esperando para sempre em vez de falhar.
  entrada.on('error', (erro) => bytes.destroy(erro));

  let cabecalho: string[] = [];
  let delim = ';';
  let numeroLinha = 0;
  let recuperadas = 0;
  let malformadas = 0;
  let lote: LinhaLida[] = [];
  /** Linhas físicas ainda não consumidas por um registro. */
  const pendentes: string[] = [];

  const emitir = async (valores: string[], payload: string, erro?: string) => {
    numeroLinha += 1;
    const campos: Record<string, string> = {};
    if (!erro) {
      cabecalho.forEach((coluna, i) => {
        if (coluna) campos[coluna] = valores[i] ?? '';
      });
    }
    // O payload guarda a linha como veio, para a tela de rejeições poder
    // mostrar o original.
    lote.push({ numeroLinha, campos, payload, ...(erro ? { erro } : {}) });
    if (lote.length >= tamanhoLote) {
      await aoLote(lote);
      lote = [];
    }
  };

  /** Consome o que já dá para decidir; `fim` indica que o arquivo acabou. */
  const consumir = async (fim: boolean) => {
    while (pendentes.length > 0) {
      const primeira = pendentes[0]!;

      if (cabecalho.length === 0) {
        if (primeira.replace(/^\uFEFF/, '').trim() === '') {
          pendentes.shift();
          continue;
        }
        const info = analisarCabecalho(primeira);
        delim = info.delimitador;
        cabecalho = info.colunas;
        if (info.semCabecalho) {
          // A primeira linha é dado: fica para ser lida como registro.
          pendentes[0] = info.primeiraLinha;
        } else {
          pendentes.shift();
        }
        continue;
      }

      if (primeira.trim() === '') {
        pendentes.shift();
        continue;
      }

      // Caminho rápido: sem aspas não há o que interpretar.
      if (!primeira.includes('"')) {
        pendentes.shift();
        const valores = primeira.split(delim).map((v) => v.trim());
        await emitir(valores, valores.join(';'));
        continue;
      }

      // Um campo entre aspas pode conter quebra de linha: junta linhas até o
      // registro fechar, dentro do teto.
      let registro: Registro | null = null;
      let usadas = 0;
      const limite = Math.min(pendentes.length, MAX_LINHAS_POR_REGISTRO);
      for (let k = 1; k <= limite; k += 1) {
        const r = analisarRegistro(pendentes.slice(0, k).join('\n'), delim);
        if (r.completo) {
          registro = r;
          usadas = k;
          break;
        }
      }

      if (!registro && !fim && pendentes.length < MAX_LINHAS_POR_REGISTRO) {
        return; // espera as próximas linhas
      }

      // Com aspa irregular, só vale o registro de uma linha só e com a
      // contagem de colunas certa: atravessando linhas, a aspa solta pode ter
      // casado com a de um registro vizinho e fundido os dois.
      if (
        registro &&
        (!registro.irregular ||
          (usadas === 1 && registro.campos.length === cabecalho.length))
      ) {
        pendentes.splice(0, usadas);
        if (registro.irregular) recuperadas += 1;
        await emitir(registro.campos, registro.campos.join(';'));
        continue;
      }

      // Não fechou, ou fechou com aspas irregulares e a contagem de colunas
      // não confere: a primeira linha é avaliada sozinha, com as aspas como
      // texto, e as seguintes voltam a ser lidas normalmente.
      pendentes.shift();
      const valores = primeira.split(delim).map(desaspar);
      if (valores.length === cabecalho.length) {
        recuperadas += 1;
        await emitir(valores, valores.join(';'));
      } else {
        malformadas += 1;
        await emitir(
          [],
          primeira.slice(0, MAX_PAYLOAD_MALFORMADO),
          `aspas desbalanceadas · ${valores.length} de ${cabecalho.length} colunas`,
        );
      }
    }
  };

  try {
    for await (const linha of linhasFisicas(bytes)) {
      pendentes.push(linha);
      await consumir(false);
    }
    await consumir(true);

    if (lote.length > 0) await aoLote(lote);
  } finally {
    // Se o consumidor abortar, fecha os descritores em vez de deixá-los presos.
    entrada.destroy();
  }

  return {
    cabecalho,
    totalColunas: cabecalho.length,
    linhas: numeroLinha,
    recuperadas,
    malformadas,
  };
}
