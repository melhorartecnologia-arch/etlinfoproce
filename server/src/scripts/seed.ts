/**
 * Popula dim_loja — a dimensão que a regra "Loja ausente em dim_loja" consulta.
 *
 * Uso: npm run seed --workspace server
 */
import { pool, fecharPool } from '../db/pool.js';

const LOJAS = [
  ['SP-8841', '1042', 'Hipermercado Zona Sul', 'SP', 'São Paulo'],
  ['SP-1027', '388', 'Supermercado Central', 'SP', 'Campinas'],
  ['SP-3390', '1042', 'Hipermercado ABC', 'SP', 'Santo André'],
  ['SP-4415', '705', 'Atacado Guarulhos', 'SP', 'Guarulhos'],
  ['RJ-1120', '388', 'Supermercado Tijuca', 'RJ', 'Rio de Janeiro'],
  ['MG-2204', '705', 'Atacado Savassi', 'MG', 'Belo Horizonte'],
  ['RS-9017', '1042', 'Hipermercado Moinhos', 'RS', 'Porto Alegre'],
];

async function main(): Promise<void> {
  for (const [idLoja, rede, nome, uf, cidade] of LOJAS) {
    await pool.query(
      `INSERT INTO infoprice.dim_loja (id_loja, rede, nome, uf, cidade)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id_loja) DO UPDATE
          SET rede = EXCLUDED.rede,
              nome = EXCLUDED.nome,
              uf = EXCLUDED.uf,
              cidade = EXCLUDED.cidade`,
      [idLoja, rede, nome, uf, cidade],
    );
  }
  console.log(`[seed] ${LOJAS.length} lojas em dim_loja`);
}

main()
  .then(() => fecharPool())
  .catch(async (erro) => {
    console.error('[seed]', erro instanceof Error ? erro.message : erro);
    await fecharPool();
    process.exit(1);
  });
