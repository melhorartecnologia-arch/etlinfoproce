/**
 * Baixa Archivo e Azeret Mono para web/public/fontes e gera o CSS que as
 * declara localmente.
 *
 * O console costuma rodar em rede interna, sem saída para a internet: depender
 * do CDN do Google faria a tipografia cair para a fonte do sistema justamente
 * onde a aplicação vive. Rode este script uma vez e versione o resultado.
 *
 * Uso: npm run baixar-fontes --workspace @infoprice/server
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const URL_CSS =
  'https://fonts.googleapis.com/css2' +
  '?family=Archivo:wght@400;500;600;700' +
  '&family=Azeret+Mono:wght@400;500;600' +
  '&display=swap';

// O user-agent decide o formato devolvido; este garante woff2.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

async function main(): Promise<void> {
  const destino = path.resolve(config.raizServidor, '..', 'web', 'public', 'fontes');
  await fs.mkdir(destino, { recursive: true });

  const resposta = await fetch(URL_CSS, { headers: { 'User-Agent': UA } });
  if (!resposta.ok) {
    throw new Error(`CSS do Google Fonts respondeu ${resposta.status}`);
  }
  let css = await resposta.text();

  const urls = [...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)]
    .map((m) => m[1]!)
    .filter((u, i, todas) => todas.indexOf(u) === i);

  console.log(`[fontes] ${urls.length} arquivos a baixar`);

  for (const url of urls) {
    const nome = url.split('/').slice(-2).join('-');
    const arquivo = path.join(destino, nome);

    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`${url} respondeu ${r.status}`);
    await fs.writeFile(arquivo, Buffer.from(await r.arrayBuffer()));

    css = css.replaceAll(url, `/fontes/${nome}`);
    console.log(`[fontes] ${nome}`);
  }

  await fs.writeFile(
    path.join(destino, 'fontes.css'),
    `/* Gerado por baixar-fontes.ts — não edite à mão.\n` +
      `   Archivo e Azeret Mono, servidas localmente para o console funcionar\n` +
      `   em rede sem saída para a internet. */\n\n${css}`,
  );

  console.log(`[fontes] pronto em ${destino}`);
}

main().catch((erro) => {
  console.error('[fontes]', erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
