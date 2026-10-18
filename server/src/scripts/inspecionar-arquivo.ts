/**
 * Mostra como o pipeline enxerga um arquivo: delimitador, cabeçalho, para qual
 * coluna interna cada nome foi mapeado e quais obrigatórias faltam. Serve para
 * acertar MAPA_COLUNAS ou CSV_COLUNAS sem precisar rodar a coleta.
 *
 * Uso:
 *   npm run inspecionar-arquivo --workspace @infoprice/server -- <arquivo.csv.gz>
 *   npm run inspecionar-arquivo --workspace @infoprice/server
 *     (sem argumento: o arquivo mais recente da área temporária)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  COLUNAS_OBRIGATORIAS,
  analisarCabecalho,
  lerCsv,
  primeirasLinhas,
  type LinhaLida,
  validarCabecalho,
} from '../ingest/leitor-csv.js';

async function maisRecente(dir: string): Promise<string | null> {
  let melhor: { caminho: string; mtime: number } | null = null;
  const visitar = async (d: string) => {
    for (const item of await fs.readdir(d, { withFileTypes: true })) {
      const c = path.join(d, item.name);
      if (item.isDirectory()) await visitar(c);
      else if (/\.csv(\.gz)?$/.test(item.name)) {
        const { mtimeMs } = await fs.stat(c);
        if (!melhor || mtimeMs > melhor.mtime) melhor = { caminho: c, mtime: mtimeMs };
      }
    }
  };
  await visitar(dir).catch(() => undefined);
  return (melhor as { caminho: string } | null)?.caminho ?? null;
}

async function main(): Promise<void> {
  const alvo = process.argv[2] ?? (await maisRecente(config.coleta.areaTemporaria));
  if (!alvo) {
    console.error(`nenhum arquivo informado nem encontrado em ${config.coleta.areaTemporaria}`);
    process.exit(1);
  }

  const linhas = await primeirasLinhas(alvo, 3);
  if (linhas.length === 0) {
    console.error(`${alvo}: arquivo vazio`);
    process.exit(1);
  }

  const info = analisarCabecalho(linhas[0]!);
  const tab = info.delimitador === '\t' ? 'tab' : info.delimitador;
  const brutos = info.primeiraLinha.split(info.delimitador);

  console.log(`arquivo       ${alvo}`);
  console.log(`delimitador   "${tab}"`);
  console.log(`colunas       ${info.colunas.length}`);
  console.log(
    `cabeçalho     ${info.semCabecalho ? 'vem de CSV_COLUNAS (arquivo sem cabeçalho)' : 'primeira linha do arquivo'}`,
  );
  if (info.pareceDado && !info.semCabecalho) {
    console.log('              ⚠ a primeira linha parece ser DADO, não nomes de coluna');
  }

  console.log('\n  #  no arquivo                     → coluna interna');
  info.colunas.forEach((interna, i) => {
    const original = info.semCabecalho ? '(posição)' : (brutos[i] ?? '').trim();
    const marca = (COLUNAS_OBRIGATORIAS as readonly string[]).includes(interna) ? '  ✓ obrigatória' : '';
    console.log(`${String(i + 1).padStart(3)}  ${original.slice(0, 30).padEnd(30)} → ${interna}${marca}`);
  });

  console.log('\nprimeiras linhas como vieram:');
  for (const l of linhas) console.log(`  ${l.slice(0, 300)}`);

  // Como as duas primeiras linhas de dado chegam ao staging, já com nulos,
  // sinônimos e campos derivados (preço, promoção) aplicados.
  const PARAR = new Error('parar');
  let amostra: LinhaLida[] = [];
  await lerCsv(alvo, async (lote) => {
    amostra = lote;
    throw PARAR;
  }, 2).catch((erro) => {
    if (erro !== PARAR) throw erro;
  });
  const exibir = ['gtin', 'descricao', 'id_loja', 'rede', 'uf', 'municipio',
    'preco', 'preco_promocional', 'tipo_preco', 'data_coleta'];
  for (const l of amostra) {
    console.log(`\nlinha ${l.numeroLinha} como vai para o staging:`);
    if (l.erro) console.log(`  ✗ ${l.erro}`);
    else for (const c of exibir) console.log(`  ${c.padEnd(18)} ${l.campos[c] || '—'}`);
  }

  const problema = validarCabecalho(info);
  console.log(
    problema
      ? `\n✗ ${problema.motivo}`
      : '\n✓ cabeçalho aceito: todas as colunas obrigatórias presentes',
  );
}

main().catch((erro) => {
  console.error('[inspecionar]', erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
