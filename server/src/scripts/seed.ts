/**
 * Popula dim_loja — a dimensão que a regra "Loja ausente em dim_loja" consulta.
 * Opcional: com CADASTRAR_LOJAS ligado (o padrão), a ingestão cadastra sozinha
 * as lojas que aparecem nos arquivos.
 *
 * Uso: npm run seed --workspace server
 */
import { pool, fecharPool } from '../db/pool.js';

const LOJAS = [
  ['STOK_CENTER-5111625', 'STOK CENTER', 'STOK_CENTER-5111625', 'RS', 'TORRES'],
  ['SUPER MUFFATO-440736', 'SUPER MUFFATO', 'SUPER MUFFATO-440736', 'PR', 'PARANAVAÍ'],
  ['PAO_DE_ACUCAR-1042', 'PÃO DE AÇÚCAR', 'PAO_DE_ACUCAR-1042', 'SP', 'SÃO PAULO'],
  ['ASSAI-388', 'ASSAÍ', 'ASSAI-388', 'SP', 'CAMPINAS'],
  ['GUANABARA-1120', 'GUANABARA', 'GUANABARA-1120', 'RJ', 'RIO DE JANEIRO'],
  ['BH-2204', 'SUPERMERCADOS BH', 'BH-2204', 'MG', 'BELO HORIZONTE'],
  ['ZAFFARI-9017', 'ZAFFARI', 'ZAFFARI-9017', 'RS', 'PORTO ALEGRE'],
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
