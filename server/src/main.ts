import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { config } from './config.js';
import { pool, fecharPool } from './db/pool.js';
import { migrar } from './db/migrate.js';
import { iniciarAgendador, pararAgendador } from './agendador/index.js';
import { rotas } from './api/rotas.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/saude', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, banco: 'conectado' });
  } catch (erro) {
    res.status(503).json({
      ok: false,
      banco: 'indisponível',
      detalhe: erro instanceof Error ? erro.message : String(erro),
    });
  }
});

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

  iniciarAgendador();

  const servidor = app.listen(config.porta, () => {
    console.log(
      `[main] console de ingestão em http://localhost:${config.porta}/api ` +
        `· origem ${config.sftp.driver} · banco ${config.banco.banco}`,
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
