import { config } from '../config.js';
import { somarDias } from '../util/tempo.js';
import type { LinhaInterpretada } from './leitor-csv.js';

/**
 * Explica, com os valores da própria linha, por que uma regra de qualidade a
 * reprovou. O motivo diz qual regra; a explicação diz o que, nesta linha,
 * fez a regra disparar — o valor do GTIN e o dígito esperado, a data e a
 * janela, e assim por diante. As condições espelham as de regras-qualidade.ts.
 */
export function explicarRejeicao(
  motivo: string,
  linha: LinhaInterpretada,
  runDate: string,
): string {
  const c = linha.campos;
  const v = (s: string | undefined) => (s && s.trim() !== '' ? `"${s.trim()}"` : 'vazio');

  switch (motivo) {
    case 'Linha malformada no arquivo':
      return linha.colunasEsperadas > 0
        ? `A linha tem ${linha.colunasLidas} colunas e o cabeçalho ${linha.colunasEsperadas}. ` +
            'Em geral é uma aspa sem par ou um delimitador a mais dentro de um texto: ' +
            'não há como saber qual valor vai em qual coluna.'
        : 'A linha não pôde ser separada em colunas (aspas desbalanceadas).';

    case 'GTIN inválido no dígito verificador':
      return explicarGtin(c.gtin);

    case 'Preço menor ou igual a zero': {
      const bruto = c.preco?.trim() ?? '';
      if (bruto === '') {
        return 'Sem preço: preco_regular e preco_pago vieram vazios.';
      }
      const n = paraNumero(bruto);
      if (n === null) return `Preço ${v(bruto)} não é um número.`;
      return `Preço ${v(bruto)} — ${n === 0 ? 'zero' : 'negativo'}. Preço precisa ser maior que zero.`;
    }

    case 'Preço acima do limite':
      return (
        `Preço ${v(c.preco)}${c.preco_promocional ? `, promocional ${v(c.preco_promocional)}` : ''}: ` +
        'a partir de 10 bilhões não cabe na coluna de preço (numeric(12,2)). Quase sempre é ' +
        'separador de milhar ou casas decimais trocados na origem.'
      );

    case 'Loja ausente em dim_loja':
      return c.id_loja?.trim()
        ? `A loja ${v(c.id_loja)} não está cadastrada em dim_loja` +
            (config.coleta.cadastrarLojas ? '.' : ' (o cadastro automático está desligado: CADASTRAR_LOJAS=false).')
        : 'Linha sem loja: as colunas loja e id_loja vieram vazias.';

    case 'Data de coleta fora da janela do run':
      return explicarData(c.data_coleta, runDate);

    case 'Duplicidade na chave de conflito':
      return (
        `A mesma chave — GTIN ${v(c.gtin)}, loja ${v(c.id_loja)}, data ${v(c.data_coleta)} — ` +
        'aparece de novo mais adiante neste arquivo. Vale a última ocorrência; esta foi descartada.'
      );

    case 'Caractere inválido na descrição':
      return explicarEncoding(c.descricao ?? '');

    default:
      return motivo;
  }
}

function explicarGtin(gtin: string | undefined): string {
  const g = (gtin ?? '').trim();
  if (g === '') return 'GTIN vazio.';
  if (!/^\d+$/.test(g)) return `GTIN "${g}" tem caracteres que não são dígitos.`;
  if (![8, 12, 13, 14].includes(g.length)) {
    return `GTIN "${g}" tem ${g.length} dígitos; os tamanhos válidos são 8, 12, 13 ou 14.`;
  }
  // Mesmo cálculo de infoprice.gtin_valido: módulo 10 GS1, pesos 3 e 1 da
  // direita para a esquerda, sem contar o próprio dígito verificador.
  let soma = 0;
  for (let i = 0; i < g.length - 1; i += 1) {
    const peso = (g.length - 1 - i) % 2 === 1 ? 3 : 1;
    soma += Number(g[i]) * peso;
  }
  const esperado = (10 - (soma % 10)) % 10;
  return `GTIN "${g}": o dígito verificador deveria ser ${esperado}, mas veio ${g[g.length - 1]}. ` +
    'Código digitado ou exportado com erro.';
}

function explicarData(bruto: string | undefined, runDate: string): string {
  const d = (bruto ?? '').trim();
  const data = paraData(d);
  if (!data) {
    return d === ''
      ? 'Data do preço vazia.'
      : `Data "${d}" em formato não reconhecido (aceitos: AAAA-MM-DD e DD/MM/AAAA).`;
  }
  if (data > runDate) {
    return `Data ${data} é posterior ao run ${runDate}: um preço não pode ter sido coletado depois do arquivo.`;
  }
  const limite = somarDias(runDate, -Math.max(0, Math.trunc(config.coleta.janelaColetaDias)));
  return `Data ${data} é anterior a ${limite}, o limite de ${config.coleta.janelaColetaDias} dias ` +
    `antes do run ${runDate} (JANELA_COLETA_DIAS).`;
}

function explicarEncoding(descricao: string): string {
  const trecho = descricao.length > 80 ? `${descricao.slice(0, 80)}…` : descricao;
  if (/\\x[0-9A-Fa-f]{2}/.test(descricao)) {
    return `A descrição traz o código de byte literal (como \\xC9) no lugar de uma letra acentuada: "${trecho}". O arquivo saiu da origem com o encoding errado.`;
  }
  if (descricao.includes('�')) {
    return `A descrição tem o caractere de substituição (�), sinal de bytes que não são UTF-8 válido: "${trecho}".`;
  }
  return `A descrição tem um caractere de controle invisível no meio do texto: "${trecho.replace(/[\u0000-\u001F\u007F]/g, '⍰')}".`;
}

function paraNumero(v: string): number | null {
  let s = v.trim();
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

function paraData(v: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(v);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}
