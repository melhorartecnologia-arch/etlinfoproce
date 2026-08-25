/**
 * Baixa o bundle de autoridades certificadoras do Amazon RDS.
 *
 * Sem ele, a única forma de falar TLS com o RDS seria desligar a verificação
 * (`rejectUnauthorized: false`), o que aceita qualquer certificado e deixa a
 * conexão aberta a interceptação — justamente o que o TLS deveria impedir.
 * Com o bundle, a verificação é real.
 *
 * O bundle global cobre todas as regiões. Rode uma vez e versione o resultado,
 * ou aponte CA_RDS para um caminho já provisionado na imagem.
 *
 * Uso: npm run baixar-ca-rds --workspace @infoprice/server
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const URL_BUNDLE = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';

async function main(): Promise<void> {
  const destino = config.banco.caRds;
  await fs.mkdir(path.dirname(destino), { recursive: true });

  console.log(`[ca-rds] baixando ${URL_BUNDLE}`);
  const resposta = await fetch(URL_BUNDLE);
  if (!resposta.ok) {
    throw new Error(`a AWS respondeu ${resposta.status}`);
  }

  const pem = await resposta.text();
  const certificados = (pem.match(/BEGIN CERTIFICATE/g) ?? []).length;
  if (certificados === 0) {
    throw new Error('o arquivo baixado não contém certificados');
  }

  await fs.writeFile(destino, pem);
  console.log(`[ca-rds] ${certificados} certificados em ${destino}`);
}

main().catch((erro) => {
  console.error('[ca-rds]', erro instanceof Error ? erro.message : erro);
  process.exit(1);
});
