/**
 * Dispara uma coleta pela linha de comando.
 *
 * Uso:
 *   npm run ingest --workspace server                    # o run de hoje
 *   npm run ingest --workspace server -- --run 2026-08-24
 *   npm run ingest --workspace server -- --run 2026-08-24 --tipo reprocessamento
 */
import { fecharPool } from '../db/pool.js';
import { executarColeta } from '../ingest/pipeline.js';
import { numeroBR } from '../util/formato.js';
import { dataLocal } from '../util/tempo.js';

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const runDate = arg('run') ?? dataLocal();
  const tipo = (arg('tipo') ?? 'incremental') as
    | 'incremental'
    | 'reprocessamento'
    | 'carga_historica';

  console.log(`[ingest] run=${runDate} · tipo=${tipo}`);

  const r = await executarColeta({
    runDate,
    tipo,
    gatilho: 'manual',
  });

  console.log('─'.repeat(60));
  console.log(`execução #${r.idExecucao} · ${r.status}`);
  console.log(`arquivos     ${r.arquivosIngeridos} de ${r.arquivosVistos}`);
  console.log(`staging      ${numeroBR(r.linhasStaging)}`);
  console.log(`gravadas     ${numeroBR(r.linhasGravadas)}`);
  console.log(`  inseridas  ${numeroBR(r.linhasInseridas)}`);
  console.log(`  atualizadas ${numeroBR(r.linhasAtualizadas)}`);
  console.log(`rejeitadas   ${numeroBR(r.linhasRejeitadas)}`);
  if (r.erro) console.log(`erro         ${r.erro}`);

  if (r.status === 'falha') process.exitCode = 1;
}

main()
  .then(() => fecharPool())
  .catch(async (erro) => {
    console.error('[ingest]', erro instanceof Error ? erro.message : erro);
    await fecharPool();
    process.exit(1);
  });
