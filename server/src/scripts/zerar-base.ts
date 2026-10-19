/**
 * Zera a base: apaga todo o histórico de dados e de metadados.
 *
 * Uso:
 *   npm run zerar-base --workspace @infoprice/server
 *   npm run zerar-base --workspace @infoprice/server -- --apagar-arquivos
 *   npm run zerar-base --workspace @infoprice/server -- --incluir-usuarios --apagar-arquivos
 *
 *   --incluir-usuarios  apaga também usuários e sessões: a aplicação volta ao
 *                       estado de instalação nova (crie o administrador de novo
 *                       com `npm run usuario -- criar ...`)
 *   --apagar-arquivos   apaga as cópias locais dos arquivos na área temporária
 *   --sim               não pergunta (para automação); sem ele, é preciso
 *                       digitar a frase de confirmação
 *
 * Pare o servidor antes (pm2 stop console-ingestao): o agendador dele poderia
 * disparar uma coleta no meio do reset.
 */
import os from 'node:os';
import readline from 'node:readline/promises';
import { config } from '../config.js';
import { fecharPool } from '../db/pool.js';
import { FRASE_CONFIRMACAO, contarBase, zerarBase } from '../admin/reset.js';

const args = process.argv.slice(2);
const incluirUsuarios = args.includes('--incluir-usuarios');
const apagarArquivos = args.includes('--apagar-arquivos');
const semPerguntar = args.includes('--sim');

const fmt = (n: number) => n.toLocaleString('pt-BR');

async function main(): Promise<void> {
  const c = await contarBase();

  console.log(`\nBanco ${config.banco.banco}@${config.banco.host} · schema infoprice\n`);
  console.log('Será APAGADO:');
  console.log(`  execuções, etapas e log     ${fmt(c.execucoes)} execuções · ${fmt(c.eventosLog)} eventos`);
  console.log(`  inventário de arquivos      ${fmt(c.arquivos)}`);
  console.log(`  preços gravados (fato)      ~${fmt(c.precos)}  · todas as partições mensais`);
  console.log(`  staging e rejeições         ${fmt(c.rejeicoes)} rejeições`);
  console.log(`  incidentes                  ${fmt(c.incidentes)}  · o código volta a #201`);
  console.log(`  lojas (dim_loja)            ${fmt(c.lojas)}`);
  console.log(`  tentativas de login         ${fmt(c.tentativasLogin)}`);
  if (incluirUsuarios) console.log(`  usuários e sessões          ${fmt(c.usuarios)} usuários`);
  if (apagarArquivos) console.log(`  cópias locais dos arquivos  ${config.coleta.areaTemporaria}`);
  console.log('\nFica:');
  console.log('  schema, regras de alerta, agendamento e o registro dos resets');
  if (!incluirUsuarios) console.log(`  ${fmt(c.usuarios)} usuários e suas sessões (use --incluir-usuarios para apagá-los)`);
  if (!apagarArquivos) console.log(`  cópias locais em ${config.coleta.areaTemporaria} (use --apagar-arquivos)`);
  console.log('\nNão há como desfazer. Faça um backup antes se houver dúvida.\n');

  if (!semPerguntar) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const resposta = await rl.question(`Digite ${FRASE_CONFIRMACAO} para confirmar: `);
    rl.close();
    if (resposta.trim() !== FRASE_CONFIRMACAO) {
      console.log('Confirmação diferente da frase · nada foi apagado.');
      return;
    }
  }

  const r = await zerarBase({
    executadoPor: `${os.userInfo().username}@${os.hostname()}`,
    origem: 'linha de comando',
    incluirUsuarios,
    apagarArquivos,
  });

  console.log(
    `\n✓ base zerada · ${fmt(r.apagado.execucoes)} execuções, ${fmt(r.apagado.arquivos)} arquivos ` +
      `e ~${fmt(r.apagado.precos)} preços apagados` +
      (apagarArquivos ? ` · ${fmt(r.arquivosRemovidos)} itens removidos da área temporária` : ''),
  );
  if (incluirUsuarios) {
    console.log(
      '\nNenhum usuário cadastrado. Crie o administrador:\n' +
        '  npm run usuario --workspace @infoprice/server -- criar --login seu.login --nome "Seu Nome" --papel administrador',
    );
  }
}

main()
  .then(() => fecharPool())
  .catch(async (erro) => {
    console.error('[zerar-base]', erro instanceof Error ? erro.message : erro);
    await fecharPool();
    process.exit(1);
  });
