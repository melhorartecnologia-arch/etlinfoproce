/**
 * Diagnóstico da conexão com o banco.
 *
 * Serve para conferir, antes de subir a aplicação, se o deploy está falando com
 * o RDS do jeito que se pretendia: cifrado, com o certificado verificado, e com
 * os tempos calibrados. A pergunta que ele responde é "a conexão está cifrada
 * de fato?", não "o banco respondeu?".
 *
 * Uso: npm run testar-conexao --workspace @infoprice/server
 */
import { config } from '../config.js';
import { fecharPool, pool } from '../db/pool.js';
import { descreverTls } from '../db/tls.js';

interface LinhaDiagnostico {
  versao: string;
  cifrada: boolean | null;
  cifra: string | null;
  usuario: string;
  banco: string;
  schema: string;
}

async function main(): Promise<void> {
  console.log('');
  console.log(`  host        ${config.banco.host}:${config.banco.porta}`);
  console.log(`  banco       ${config.banco.banco}`);
  console.log(`  usuário     ${config.banco.usuario}`);
  console.log(`  credencial  ${config.banco.credencial}`);
  console.log(`  tls         ${config.banco.sslModo} · ${descreverTls()}`);
  console.log('');

  const inicio = Date.now();
  const { rows } = await pool.query<LinhaDiagnostico>(
    `SELECT current_setting('server_version')            AS versao,
            s.ssl                                        AS cifrada,
            s.cipher                                     AS cifra,
            current_user                                 AS usuario,
            current_database()                           AS banco,
            current_setting('search_path')               AS schema
       FROM pg_stat_ssl s
      WHERE s.pid = pg_backend_pid()`,
  );
  const latencia = Date.now() - inicio;
  const d = rows[0];

  if (!d) {
    throw new Error('o banco respondeu, mas sem linha de diagnóstico');
  }

  console.log(`  PostgreSQL  ${d.versao}`);
  console.log(`  conectado   ${d.usuario}@${d.banco} · search_path ${d.schema}`);
  console.log(`  latência    ${latencia} ms`);
  console.log(
    `  cifrada     ${d.cifrada ? `sim · ${d.cifra}` : 'NÃO — tráfego em texto claro'}`,
  );
  console.log('');

  // Um deploy em nuvem sem cifra é um erro de configuração, não um detalhe.
  const remoto = !/^(127\.|localhost|::1|\/)/.test(config.banco.host);
  if (remoto && !d.cifrada) {
    console.error(
      '  ATENÇÃO: o banco é remoto e a conexão NÃO está cifrada.\n' +
        '  Defina PGSSLMODE=verify-full e provisione o bundle de CAs.\n',
    );
    process.exitCode = 1;
    return;
  }

  if (config.banco.sslModo === 'require') {
    console.warn(
      '  AVISO: PGSSLMODE=require cifra mas não verifica o certificado.\n' +
        '  Contra o RDS, prefira verify-full.\n',
    );
  }

  console.log('  conexão de acordo com o configurado.');
  console.log('');
}

main()
  .then(() => fecharPool())
  .catch(async (erro) => {
    console.error('');
    console.error(`  FALHOU: ${erro instanceof Error ? erro.message : erro}`);
    console.error('');
    await fecharPool().catch(() => undefined);
    process.exit(1);
  });
