import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { pool, fecharPool } from './pool.js';

const diretorioMigracoes = path.resolve(config.raizServidor, '..', 'db', 'migrations');

/**
 * Aplica as migrações ainda não registradas, em ordem de nome de arquivo.
 * Cada migração roda na própria transação, então uma falha não deixa metade
 * de um arquivo aplicada.
 */
export async function migrar(): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      nome        text PRIMARY KEY,
      aplicada_em timestamptz NOT NULL DEFAULT now()
    )
  `);

  const arquivos = (await fs.readdir(diretorioMigracoes))
    .filter((n) => n.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query<{ nome: string }>(
    'SELECT nome FROM public.schema_migrations',
  );
  const aplicadas = new Set(rows.map((r) => r.nome));

  const novas: string[] = [];
  for (const arquivo of arquivos) {
    if (aplicadas.has(arquivo)) continue;

    const sql = await fs.readFile(path.join(diretorioMigracoes, arquivo), 'utf8');
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await cliente.query(sql);
      await cliente.query(
        'INSERT INTO public.schema_migrations (nome) VALUES ($1)',
        [arquivo],
      );
      await cliente.query('COMMIT');
      novas.push(arquivo);
      console.log(`[migrate] aplicada ${arquivo}`);
    } catch (erro) {
      await cliente.query('ROLLBACK');
      throw new Error(
        `falha na migração ${arquivo}: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
    } finally {
      cliente.release();
    }
  }

  if (novas.length === 0) console.log('[migrate] nada a aplicar');
  return novas;
}

const executadoDireto =
  process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (executadoDireto) {
  migrar()
    .then(() => fecharPool())
    .catch(async (erro) => {
      console.error('[migrate]', erro instanceof Error ? erro.message : erro);
      await fecharPool();
      process.exit(1);
    });
}
