import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { pool, fecharPool, estadoPool } from './db/pool.js';
import { descreverTls } from './db/tls.js';
import { migrar } from './db/migrate.js';
import { iniciarAgendador, pararAgendador } from './agendador/index.js';
import { rotas } from './api/rotas.js';
import { rotasAuth } from './api/rotas-auth.js';
import { rotasUsuarios } from './api/rotas-usuarios.js';
import { consultarUm } from './db/pool.js';

const app = express();

/**
 * A sessão viaja num cookie, então o CORS precisa permitir credenciais — e
 * `credentials: true` é incompatível com origem `*`. Em desenvolvimento o
 * console é servido pelo proxy do Vite (mesma origem, sem CORS); a lista existe
 * para quando o front for publicado noutro host.
 */
app.use(
  cors({
    origin: config.origensPermitidas.length > 0 ? config.origensPermitidas : true,
    credentials: true,
  }),
);
app.use(express.json({ limit: '1mb' }));

// Atrás de um proxy reverso, o IP real vem em X-Forwarded-For; sem isto o
// bloqueio por tentativas contaria todo mundo como o mesmo endereço.
app.set('trust proxy', true);

/**
 * Health check para o balanceador e para o diagnóstico do deploy.
 *
 * Reporta se a conexão está cifrada de fato, e não só se o banco respondeu:
 * um deploy que caiu para texto claro contra o RDS é exatamente o tipo de erro
 * que passa despercebido porque a aplicação continua funcionando.
 */
app.get('/api/saude', async (_req, res) => {
  const inicio = Date.now();
  try {
    const r = await pool.query<{ cifrada: boolean | null; versao: string }>(
      `SELECT (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS cifrada,
              current_setting('server_version') AS versao`,
    );

    res.json({
      ok: true,
      banco: 'conectado',
      versao: r.rows[0]?.versao,
      tls: {
        configurado: descreverTls(),
        conexaoCifrada: r.rows[0]?.cifrada ?? false,
      },
      pool: estadoPool(),
      latenciaMs: Date.now() - inicio,
    });
  } catch (erro) {
    res.status(503).json({
      ok: false,
      banco: 'indisponível',
      detalhe: erro instanceof Error ? erro.message : String(erro),
      latenciaMs: Date.now() - inicio,
    });
  }
});

// Login, logout e "quem sou eu" ficam fora da área protegida — são justamente
// o caminho para entrar nela.
app.use('/api', rotasAuth);

// Gestão de usuários: exige sessão e papel de administrador, aplicados dentro
// do próprio router. Montado num caminho próprio para que esse middleware não
// alcance o resto da API.
app.use('/api/usuarios', rotasUsuarios);

// Tudo abaixo exige sessão.
app.use('/api', rotas);

app.use((_req, res) => {
  res.status(404).json({ erro: 'rota não encontrada' });
});

app.use((erro: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const mensagem = erro instanceof Error ? erro.message : String(erro);
  console.error('[api]', mensagem);

  // "já existe uma coleta em andamento" é uma condição esperada, não uma falha
  // do servidor: a tela mostra o aviso e o operador tenta de novo.
  const conflito = mensagem.includes('já existe uma coleta em andamento');
  res.status(conflito ? 409 : 500).json({ erro: mensagem });
});

async function iniciar(): Promise<void> {
  try {
    await migrar();
  } catch (erro) {
    console.error(
      '[main] não foi possível aplicar as migrações:',
      erro instanceof Error ? erro.message : erro,
    );
    process.exit(1);
  }

  // Instalação nova não tem ninguém cadastrado, e não criamos um admin padrão
  // de propósito: uma senha conhecida em toda instalação é uma porta aberta.
  const usuarios = await consultarUm<{ total: number }>(
    'SELECT count(*)::int AS total FROM infoprice.ctl_usuario WHERE ativo',
  );
  if ((usuarios?.total ?? 0) === 0) {
    console.warn('');
    console.warn('  ┌─────────────────────────────────────────────────────────┐');
    console.warn('  │  Nenhum usuário cadastrado — o console está inacessível. │');
    console.warn('  │                                                         │');
    console.warn('  │  Crie o primeiro administrador:                         │');
    console.warn('  │                                                         │');
    console.warn('  │  npm run usuario --workspace @infoprice/server -- \\     │');
    console.warn('  │      criar --login seu.login --nome "Seu Nome" \\        │');
    console.warn('  │      --papel administrador                              │');
    console.warn('  └─────────────────────────────────────────────────────────┘');
    console.warn('');
  }

  iniciarAgendador();

  const servidor = app.listen(config.porta, () => {
    console.log(
      `[main] console de ingestão em http://localhost:${config.porta}/api ` +
        `· origem ${config.sftp.driver} ` +
        `· banco ${config.banco.banco}@${config.banco.host} ` +
        `· ${descreverTls()} ` +
        `· credencial ${config.banco.credencial}`,
    );
  });

  const encerrar = async (sinal: string) => {
    console.log(`[main] ${sinal} recebido · encerrando`);
    pararAgendador();
    servidor.close();
    await fecharPool();
    process.exit(0);
  };

  process.on('SIGINT', () => void encerrar('SIGINT'));
  process.on('SIGTERM', () => void encerrar('SIGTERM'));
}

void iniciar();
