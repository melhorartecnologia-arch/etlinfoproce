import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { stringify } from 'csv-stringify';
import PDFDocument from 'pdfkit';
import * as tar from 'tar-stream';
import type {
  AcaoResposta,
  ConfigResposta,
  DetalheExecucaoResposta,
  IncidentesResposta,
  InventarioResposta,
  LinhagemResposta,
  PainelResposta,
  PrecosResposta,
  QualidadeResposta,
  StatusResposta,
} from '@infoprice/shared';
import { config } from '../config.js';
import { consultar, consultarUm } from '../db/pool.js';
import {
  coletaDiariaComTentativas,
  comTrilho,
  pausarAgendamento,
  proximaExecucao,
  retomarAgendamento,
  varredura,
} from '../agendador/index.js';
import { executarColeta } from '../ingest/pipeline.js';
import { SQL_PERSISTENCIA } from '../ingest/merge-incremental.js';
import { resolverIncidente } from '../alertas/index.js';
import {
  exigirAutenticacao,
  exigirOperador,
} from '../auth/middleware.js';
import { bytesBR, duracaoBR, numeroBR, percentualBR } from '../util/formato.js';
import { dataLocal } from '../util/tempo.js';
import * as q from './consultas.js';

export const rotas = Router();

/**
 * Toda esta área exige sessão. Nada de dado operacional sai sem alguém
 * identificado do outro lado — nem para leitura.
 */
rotas.use(exigirAutenticacao);

/** Quem está operando, segundo a sessão. */
function operador(req: Request): string {
  return req.usuario!.login;
}

/** O id do usuário, para gravar autoria nas tabelas de controle. */
function idOperador(req: Request): number {
  return req.usuario!.id;
}

function inteiro(valor: unknown, padrao: number): number {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : padrao;
}

/** Envolve um handler async, encaminhando erros ao middleware de erro. */
function rota(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: (e?: unknown) => void) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

// ── Status e agendamento ────────────────────────────────────────────────────

rotas.get(
  '/status',
  rota(async (_req, res) => {
    const agendamento = await consultarUm<{
      pausado: boolean;
      cron: string;
      timezone: string;
      pausado_em: string | null;
      pausado_por: string | null;
    }>('SELECT * FROM infoprice.ctl_agendamento WHERE id = 1');

    const ultimo = await consultarUm<{ visto_em: string }>(
      'SELECT max(visto_em) AS visto_em FROM infoprice.ctl_arquivo',
    );

    const resposta: StatusResposta = {
      sftp: {
        host:
          config.sftp.driver === 'sftp'
            ? `${config.sftp.host}:${config.sftp.porta}`
            : 'origem local (modo desenvolvimento)',
        usuario: config.sftp.usuario,
        chave: config.sftp.chavePrivada
          ? config.sftp.chavePrivada.split('/').pop() ?? ''
          : 'senha do cofre',
        diretorioBase: config.sftp.diretorioBase,
        conectado: Boolean(ultimo?.visto_em),
        verificadoEm: ultimo?.visto_em ?? null,
      },
      agendamento: {
        pausado: agendamento?.pausado ?? false,
        cron: agendamento?.cron ?? config.agendamento.cronColeta,
        timezone: agendamento?.timezone ?? config.agendamento.timezone,
        proximaExecucao: await proximaExecucao(),
        pausadoEm: agendamento?.pausado_em ?? null,
        pausadoPor: agendamento?.pausado_por ?? null,
      },
      banco: {
        instancia: config.banco.instanciaRotulo,
        banco: config.banco.banco,
        schema: config.banco.schema,
      },
    };

    res.json(resposta);
  }),
);

rotas.post(
  '/agendamento/pausar',
  exigirOperador,
  rota(async (req, res) => {
    const quem = operador(req);
    await pausarAgendamento(quem, idOperador(req));
    const r: AcaoResposta = {
      ok: true,
      mensagem: 'Agendamento pausado · nenhuma coleta automática será disparada',
    };
    res.json(r);
  }),
);

rotas.post(
  '/agendamento/retomar',
  exigirOperador,
  rota(async (_req, res) => {
    await retomarAgendamento();
    const proxima = await proximaExecucao();
    const quando = proxima
      ? new Date(proxima).toLocaleString('pt-BR', {
          timeZone: config.agendamento.timezone,
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : 'conforme agendamento';
    const r: AcaoResposta = {
      ok: true,
      mensagem: `Agendamento retomado · próxima coleta ${quando}`,
    };
    res.json(r);
  }),
);

// ── Painel do dia ───────────────────────────────────────────────────────────

rotas.get(
  '/painel',
  rota(async (req, res) => {
    const runDate = (req.query.run as string) || dataLocal();
    const execucao = await q.execucaoDoRun(runDate);
    const etapas = execucao ? await q.etapasDaExecucao(execucao.id) : [];
    const historico = await q.historicoExecucoes(
      inteiro(req.query.limite, 12),
    );

    let kpis: PainelResposta['kpis'];
    let aviso: PainelResposta['aviso'] = null;

    if (!execucao) {
      kpis = {
        status: 'Sem execução',
        janela: `nenhuma coleta registrada para ${runDate}`,
        arquivos: '—',
        bytes: '—',
        linhas: '—',
        linhasNota: 'fact_preco_coletado',
        rejeicoes: '—',
      };
      aviso = {
        tag: 'aguardando',
        tom: 'info',
        texto:
          `Ainda não houve coleta para run=${runDate}. ` +
          `A próxima execução automática está agendada para ${config.agendamento.cronColeta} ` +
          `(${config.agendamento.timezone}); a coleta manual dispara na hora.`,
      };
    } else {
      const hora = (v: string | null) =>
        v
          ? new Date(v).toLocaleTimeString('pt-BR', {
              timeZone: config.agendamento.timezone,
              hour: '2-digit',
              minute: '2-digit',
            })
          : 'agora';

      const janela =
        execucao.status === 'em_execucao'
          ? `${hora(execucao.iniciadoEm)} → agora · ${duracaoBR(execucao.duracaoMs)}`
          : `${hora(execucao.iniciadoEm)} → ${hora(execucao.finalizadoEm)} · ${duracaoBR(execucao.duracaoMs)}`;

      const pct =
        execucao.linhasStaging > 0
          ? (execucao.linhasRejeitadas / execucao.linhasStaging) * 100
          : 0;

      kpis = {
        status: q.rotuloStatus(execucao.status),
        janela,
        arquivos: `${execucao.arquivosIngeridos} / ${execucao.arquivosVistos}`,
        bytes: `${bytesBR(execucao.bytesBaixados)} · csv.gz`,
        linhas:
          execucao.status === 'em_execucao'
            ? `${numeroBR(execucao.linhasStaging)} em staging`
            : numeroBR(execucao.linhasGravadas),
        linhasNota: 'fact_preco_coletado',
        rejeicoes:
          execucao.status === 'em_execucao'
            ? 'apurando'
            : execucao.linhasRejeitadas > 0
              ? `${numeroBR(execucao.linhasRejeitadas)} · ${percentualBR(pct)}`
              : '0',
      };

      // O aviso reflete o estado real: erro, execução em curso, ou o alerta
      // informativo de retenção quando há pastas prestes a expirar.
      if (execucao.status === 'falha') {
        const incidente = await consultarUm<{ codigo: string }>(
          `SELECT codigo FROM infoprice.ctl_incidente
            WHERE id_execucao = $1 ORDER BY id DESC LIMIT 1`,
          [execucao.id],
        );
        const motivo = execucao.erro ?? 'A execução terminou em falha';
        aviso = {
          tag: incidente ? `incidente ${incidente.codigo}` : 'falha',
          tom: 'erro',
          texto:
            `${motivo.replace(/\.?\s*$/, '')}. ` +
            'Nada foi gravado: a transação de staging foi revertida.',
        };
      } else if (execucao.status === 'em_execucao') {
        aviso = {
          tag: 'em andamento',
          tom: 'info',
          texto:
            `Coleta em curso desde ${hora(execucao.iniciadoEm)}. ` +
            'O merge na tabela final só ocorre após a validação, então a ' +
            'fact_preco_coletado ainda mostra o dado da execução anterior.',
        };
      } else if (execucao.status === 'parcial') {
        aviso = {
          tag: 'parcial',
          tom: 'atencao',
          texto:
            `${execucao.arquivosIngeridos} de ${execucao.arquivosVistos} arquivos foram ingeridos. ` +
            'Os pendentes seguem no inventário e serão retomados na próxima varredura.',
        };
      } else {
        const expirando = await consultarUm<{ pasta: string; total: number }>(
          `SELECT pasta, count(*)::bigint AS total
             FROM infoprice.ctl_arquivo
            WHERE expira_em IS NOT NULL
              AND expira_em <= current_date + 1
              AND expira_em >= current_date
            GROUP BY pasta
            ORDER BY pasta
            LIMIT 1`,
        );
        if (expirando) {
          aviso = {
            tag: 'retenção',
            tom: 'atencao',
            texto:
              `Os arquivos de ${expirando.pasta} expiram hoje na origem ` +
              `(retenção de ${config.coleta.retencaoOrigemDias} dias). ` +
              'A cópia local já está arquivada e o hash confere, então nenhuma ação é necessária.',
          };
        }
      }
    }

    const resposta: PainelResposta = {
      runDate,
      execucao,
      etapas,
      kpis,
      aviso,
      historico,
    };
    res.json(resposta);
  }),
);

// ── Execuções ───────────────────────────────────────────────────────────────

rotas.get(
  '/execucoes',
  rota(async (req, res) => {
    res.json(await q.historicoExecucoes(inteiro(req.query.limite, 20)));
  }),
);

rotas.get(
  '/execucoes/:id',
  rota(async (req, res) => {
    const id = Number(req.params.id);
    const execucao = await q.buscarExecucao(id);
    if (!execucao) {
      res.status(404).json({ erro: 'execução não encontrada' });
      return;
    }

    const [etapas, log, arquivos] = await Promise.all([
      q.etapasDaExecucao(id),
      q.logDaExecucao(id, inteiro(req.query.log, 200)),
      q.arquivosDaExecucao(id),
    ]);

    const resposta: DetalheExecucaoResposta = {
      execucao,
      resumo:
        execucao.status === 'falha'
          ? `Execução interrompida após ${duracaoBR(execucao.duracaoMs)} · ${execucao.erro ?? 'sem detalhe'}`
          : `${q.rotuloTipo(execucao.tipo)} ${q.concordancia(execucao.tipo, execucao.status)} em ${duracaoBR(
              execucao.duracaoMs,
            )} · ${numeroBR(execucao.linhasGravadas)} linhas efetivadas em uma única transação`,
      cards: [
        {
          rotulo: 'gatilho',
          valor:
            execucao.gatilho === 'agendador'
              ? `agendador · cron ${config.agendamento.cronColeta}`
              : execucao.gatilho,
          nota: `fuso ${config.agendamento.timezone}`,
        },
        {
          rotulo: 'origem',
          valor: `${config.coleta.fonte}/run=${execucao.runDate}`,
          nota: `${execucao.arquivosVistos} arquivos csv.gz · ${bytesBR(execucao.bytesBaixados)}`,
        },
        {
          rotulo: 'destino',
          valor: `${config.banco.banco}.${config.banco.schema}`,
          nota: 'staging + fato + tabelas de controle',
        },
        {
          rotulo: 'assinatura da execução',
          valor: `#${execucao.id} · ${execucao.assinatura}`,
          nota: 'gravada em cada linha do fato',
        },
      ],
      idempotencia: [
        { chave: 'Chave de conflito', valor: '(gtin, id_loja, data_coleta, fonte)' },
        { chave: 'Watermark anterior', valor: execucao.watermarkAnterior ?? '—' },
        { chave: 'Watermark após execução', valor: execucao.watermarkNovo ?? '—' },
        {
          chave: 'Reexecução do mesmo run',
          valor: 'segura · substitui staging e reaplica upsert',
        },
        { chave: 'Transação', valor: 'única · rollback total em qualquer falha' },
        {
          chave: 'Retenção do arquivo local',
          valor: `${config.coleta.retencaoLocalDias} dias em ${config.coleta.areaTemporaria}`,
        },
      ],
      sqlPersistencia: SQL_PERSISTENCIA.replace('{run}', execucao.runDate),
      etapas,
      log: log.eventos,
      totalEventos: log.total,
      arquivos,
    };

    res.json(resposta);
  }),
);

rotas.post(
  '/execucoes',
  exigirOperador,
  rota(async (req, res) => {
    const runDate = (req.body?.run as string) || dataLocal();
    const quem = operador(req);

    // A coleta roda em segundo plano: a tela recebe a confirmação na hora e
    // acompanha o progresso pelo painel.
    const idUsuario = idOperador(req);
    comTrilho(() =>
      coletaDiariaComTentativas(runDate, 'manual', idUsuario),
    ).catch((erro) => console.error('[coleta manual]', erro.message));

    const r: AcaoResposta = {
      ok: true,
      mensagem: `Coleta manual de run=${runDate} disparada por ${quem}`,
    };
    res.status(202).json(r);
  }),
);

rotas.post(
  '/execucoes/:id/reprocessar',
  exigirOperador,
  rota(async (req, res) => {
    const id = Number(req.params.id);
    const execucao = await q.buscarExecucao(id);
    if (!execucao) {
      res.status(404).json({ erro: 'execução não encontrada' });
      return;
    }

    comTrilho(() =>
      executarColeta({
        runDate: execucao.runDate,
        gatilho: 'reprocessamento',
        tipo: 'reprocessamento',
      }),
    ).catch((erro) => console.error('[reprocessar run]', erro.message));

    const r: AcaoResposta = {
      ok: true,
      mensagem: `Reprocessamento do run=${execucao.runDate} enfileirado`,
    };
    res.status(202).json(r);
  }),
);

// ── Linhagem ────────────────────────────────────────────────────────────────

rotas.get(
  '/execucoes/:id/linhagem',
  rota(async (req, res) => {
    const id = Number(req.params.id);
    const execucao = await q.buscarExecucao(id);
    if (!execucao) {
      res.status(404).json({ erro: 'execução não encontrada' });
      return;
    }

    const resposta: LinhagemResposta = {
      runDate: execucao.runDate,
      idExecucao: execucao.id,
      fluxo: await q.fluxoLinhagem(execucao),
      porArquivo: await q.linhagemPorArquivo(execucao.id),
    };
    res.json(resposta);
  }),
);

rotas.get(
  '/linhagem/preco/:id',
  rota(async (req, res) => {
    const campos = await q.caminhoInverso(req.params.id);
    if (!campos) {
      res.status(404).json({ erro: 'linha não encontrada no fato' });
      return;
    }
    res.json({ id: req.params.id, campos });
  }),
);

/** Uma linha qualquer do run, para a tela de linhagem abrir já com exemplo. */
rotas.get(
  '/linhagem/exemplo',
  rota(async (req, res) => {
    const idExecucao = Number(req.query.execucao);
    const linha = await consultarUm<{ id: string }>(
      Number.isFinite(idExecucao) && idExecucao > 0
        ? `SELECT id::text FROM infoprice.fact_preco_coletado
            WHERE id_execucao = $1 ORDER BY atualizado_em DESC LIMIT 1`
        : `SELECT id::text FROM infoprice.fact_preco_coletado
            ORDER BY atualizado_em DESC LIMIT 1`,
      Number.isFinite(idExecucao) && idExecucao > 0 ? [idExecucao] : [],
    );

    if (!linha) {
      res.json({ id: null, campos: [] });
      return;
    }

    res.json({ id: linha.id, campos: await q.caminhoInverso(linha.id) });
  }),
);

// ── Inventário SFTP ─────────────────────────────────────────────────────────

rotas.get(
  '/inventario',
  rota(async (_req, res) => {
    const pastas = await q.inventario();

    const cargaInicial = await consultarUm<{
      pasta: string;
      arquivos: number;
      linhas: number;
    }>(
      `SELECT a.pasta,
              count(DISTINCT a.id)::bigint                    AS arquivos,
              COALESCE(sum(ea.linhas_gravadas), 0)::bigint    AS linhas
         FROM infoprice.ctl_arquivo a
         LEFT JOIN infoprice.ctl_execucao_arquivo ea
                ON ea.id_arquivo = a.id AND ea.id_execucao = a.id_execucao
        GROUP BY a.pasta
        ORDER BY count(DISTINCT a.id) DESC
        LIMIT 1`,
    );

    // Só faz sentido chamar de "carga inicial" a pasta muito maior que as
    // outras — é o histórico de 90 dias que o fornecedor mandou de uma vez.
    const mediaArquivos =
      pastas.length > 0
        ? pastas.reduce((s, p) => s + p.arquivos, 0) / pastas.length
        : 0;
    const ehCargaInicial =
      cargaInicial !== null &&
      pastas.length > 1 &&
      cargaInicial.arquivos > mediaArquivos * 3;

    const resposta: InventarioResposta = {
      cards: {
        pastasNaOrigem: pastas.filter(
          (p) => p.expiraEmDias === null || p.expiraEmDias >= 0,
        ).length,
        arquivosPendentes: pastas.reduce((s, p) => s + p.pendentes, 0),
        expiramEm24h: pastas
          .filter((p) => p.expiraEmDias !== null && p.expiraEmDias >= 0 && p.expiraEmDias <= 1)
          .reduce((s, p) => s + p.arquivos, 0),
        retencaoDias: config.coleta.retencaoOrigemDias,
      },
      pastas,
      cargaInicial: ehCargaInicial
        ? {
            pasta: cargaInicial.pasta,
            arquivos: cargaInicial.arquivos,
            linhas: cargaInicial.linhas,
            desde: pastas[pastas.length - 1]?.runDate ?? '',
          }
        : null,
    };

    res.json(resposta);
  }),
);

rotas.post(
  '/inventario/:pasta/reprocessar',
  exigirOperador,
  rota(async (req, res) => {
    const pasta = req.params.pasta;
    const m = /^run=(\d{4}-\d{2}-\d{2})$/.exec(pasta);
    if (!m) {
      res.status(400).json({ erro: 'pasta inválida' });
      return;
    }

    comTrilho(() =>
      executarColeta({
        runDate: m[1]!,
        gatilho: 'reprocessamento',
        tipo: 'reprocessamento',
      }),
    ).catch((erro) => console.error('[reprocessar pasta]', erro.message));

    const r: AcaoResposta = {
      ok: true,
      mensagem: `Reprocessamento de ${pasta} enfileirado`,
    };
    res.status(202).json(r);
  }),
);

/**
 * Baixa todos os arquivos de uma pasta run= num único .tar.
 *
 * São as cópias locais, byte a byte iguais às da origem (o hash de cada uma foi
 * conferido na ingestão), então o pacote serve como evidência de auditoria
 * mesmo depois de o fornecedor expirar a pasta.
 */
rotas.get(
  '/inventario/:pasta/download',
  exigirOperador,
  rota(async (req, res) => {
    const pasta = req.params.pasta;
    if (!/^run=\d{4}-\d{2}-\d{2}$/.test(pasta)) {
      res.status(400).json({ erro: 'pasta inválida' });
      return;
    }

    const arquivos = await consultar<{
      nome: string;
      caminho_local: string | null;
    }>(
      `SELECT nome, caminho_local
         FROM infoprice.ctl_arquivo
        WHERE pasta = $1 AND caminho_local IS NOT NULL
        ORDER BY nome`,
      [pasta],
    );

    const disponiveis = arquivos.filter(
      (a) => a.caminho_local && fs.existsSync(a.caminho_local),
    );

    if (disponiveis.length === 0) {
      res.status(410).json({
        erro: 'nenhuma cópia local disponível para esta pasta',
        detalhe:
          'Os arquivos saíram da área temporária. Reprocesse a pasta para baixá-los de novo da origem.',
      });
      return;
    }

    res.setHeader('Content-Type', 'application/x-tar');
    res.setHeader('Content-Disposition', `attachment; filename="${pasta}.tar"`);

    const pacote = tar.pack();
    pacote.pipe(res);

    try {
      for (const arquivo of disponiveis) {
        const caminho = arquivo.caminho_local!;
        const info = await fsp.stat(caminho);
        await new Promise<void>((resolver, rejeitar) => {
          const entrada = pacote.entry(
            { name: `${pasta}/${arquivo.nome}`, size: info.size },
            (erro) => (erro ? rejeitar(erro) : resolver()),
          );
          fs.createReadStream(caminho).pipe(entrada);
        });
      }
      pacote.finalize();
    } catch (erro) {
      pacote.destroy();
      console.error(
        '[download pasta]',
        erro instanceof Error ? erro.message : erro,
      );
      res.destroy();
    }
  }),
);

rotas.post(
  '/varredura',
  exigirOperador,
  rota(async (_req, res) => {
    varredura().catch((erro) => console.error('[varredura]', erro.message));
    const r: AcaoResposta = {
      ok: true,
      mensagem: 'Varredura de segurança disparada',
    };
    res.status(202).json(r);
  }),
);

// ── Arquivos ────────────────────────────────────────────────────────────────

rotas.post(
  '/arquivos/:id/reprocessar',
  exigirOperador,
  rota(async (req, res) => {
    const arquivo = await q.buscarArquivo(Number(req.params.id));
    if (!arquivo) {
      res.status(404).json({ erro: 'arquivo não encontrado' });
      return;
    }

    comTrilho(() =>
      executarColeta({
        runDate: arquivo.runDate,
        gatilho: 'reprocessamento',
        tipo: 'reprocessamento',
        somenteArquivos: [arquivo.nome],
      }),
    ).catch((erro) => console.error('[reprocessar arquivo]', erro.message));

    const r: AcaoResposta = {
      ok: true,
      mensagem: `Reprocessamento de ${arquivo.nome} enfileirado`,
    };
    res.status(202).json(r);
  }),
);

/** Baixa a cópia local do arquivo bruto, exatamente como veio da origem. */
rotas.get(
  '/arquivos/:id/download',
  exigirOperador,
  rota(async (req, res) => {
    const arquivo = await q.buscarArquivo(Number(req.params.id));
    if (!arquivo) {
      res.status(404).json({ erro: 'arquivo não encontrado' });
      return;
    }
    if (!arquivo.caminhoLocal || !fs.existsSync(arquivo.caminhoLocal)) {
      res.status(410).json({
        erro: 'cópia local indisponível',
        detalhe:
          'O arquivo foi removido da área temporária. Reprocesse a pasta para baixá-lo de novo da origem.',
      });
      return;
    }

    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${arquivo.nome}"`,
    );
    if (arquivo.sha256) res.setHeader('X-Conteudo-SHA256', arquivo.sha256);

    fs.createReadStream(arquivo.caminhoLocal).pipe(res);
    return;
  }),
);

// ── Qualidade e rejeições ───────────────────────────────────────────────────

rotas.get(
  '/qualidade',
  rota(async (req, res) => {
    const runDate = (req.query.run as string) || dataLocal();
    const execucao = await q.execucaoDoRun(runDate);

    if (!execucao) {
      const vazio: QualidadeResposta = {
        runDate,
        idExecucao: null,
        totalLinhas: 0,
        totalRejeitadas: 0,
        percentual: 0,
        motivos: [],
        rejeicoes: [],
      };
      res.json(vazio);
      return;
    }

    const [motivos, lista] = await Promise.all([
      q.motivosRejeicao(execucao.id),
      q.rejeicoes(execucao.id, inteiro(req.query.limite, 50)),
    ]);

    const resposta: QualidadeResposta = {
      runDate,
      idExecucao: execucao.id,
      totalLinhas: execucao.linhasStaging,
      totalRejeitadas: execucao.linhasRejeitadas,
      percentual:
        execucao.linhasStaging > 0
          ? (execucao.linhasRejeitadas / execucao.linhasStaging) * 100
          : 0,
      motivos,
      rejeicoes: lista,
    };
    res.json(resposta);
  }),
);

// ── Incidentes e regras ─────────────────────────────────────────────────────

rotas.get(
  '/incidentes',
  rota(async (_req, res) => {
    const [incidentes, regras] = await Promise.all([
      q.listarIncidentes(),
      q.listarRegras(),
    ]);

    const resposta: IncidentesResposta = {
      incidentes,
      regras,
      abertos: incidentes.filter((i) => i.status === 'aberto').length,
    };
    res.json(resposta);
  }),
);

rotas.post(
  '/incidentes/:codigo/resolver',
  exigirOperador,
  rota(async (req, res) => {
    const quem = operador(req);
    const codigo = decodeURIComponent(req.params.codigo);
    const ok = await resolverIncidente(codigo, quem, idOperador(req));

    if (!ok) {
      res.status(404).json({ erro: 'incidente não encontrado ou já resolvido' });
      return;
    }

    const r: AcaoResposta = {
      ok: true,
      mensagem: `Incidente ${codigo} marcado como resolvido por ${quem}`,
    };
    res.json(r);
  }),
);

// ── Consulta de preços ──────────────────────────────────────────────────────

rotas.get(
  '/precos',
  rota(async (req, res) => {
    const filtros = {
      data: (req.query.data as string) || undefined,
      uf: (req.query.uf as string) || undefined,
      busca: (req.query.busca as string) || undefined,
      tipo: (req.query.tipo as string) || undefined,
      limite: Math.min(inteiro(req.query.limite, 50), 500),
    };

    const { linhas, total, atualizadoEm } = await q.consultarPrecos(filtros);

    const resposta: PrecosResposta = {
      total,
      exibindo: linhas.length,
      atualizadoEm,
      filtros,
      linhas,
    };
    res.json(resposta);
  }),
);

rotas.get(
  '/precos/ufs',
  rota(async (_req, res) => {
    res.json(await q.ufsDisponiveis());
  }),
);

// ── Configuração ────────────────────────────────────────────────────────────

rotas.get(
  '/config',
  rota(async (_req, res) => {
    const agendamento = await consultarUm<{ cron: string; timezone: string }>(
      'SELECT cron, timezone FROM infoprice.ctl_agendamento WHERE id = 1',
    );

    const resposta: ConfigResposta = {
      blocos: [
        {
          titulo: 'Origem SFTP',
          linhas: [
            { chave: 'Host', valor: config.sftp.host },
            { chave: 'Porta', valor: `${config.sftp.porta} (SFTP sobre SSH)` },
            { chave: 'Usuário', valor: config.sftp.usuario },
            {
              chave: 'Autenticação',
              valor: config.sftp.chavePrivada
                ? `chave ${config.sftp.chavePrivada.split('/').pop()}`
                : 'senha do cofre',
            },
            // A senha nunca aparece: a aplicação recebe apenas a referência.
            { chave: 'Senha', valor: 'referência vault/infoprice/sftp' },
            { chave: 'Diretório base', valor: config.sftp.diretorioBase },
            { chave: 'Padrão de pasta', valor: 'run=AAAA-MM-DD' },
            {
              chave: 'Retenção na origem',
              valor: `${config.coleta.retencaoOrigemDias} dias`,
            },
          ],
        },
        {
          titulo: 'Agendamento e tolerância',
          linhas: [
            {
              chave: 'Coleta diária',
              valor: `${agendamento?.cron ?? config.agendamento.cronColeta} ${
                agendamento?.timezone ?? config.agendamento.timezone
              }`,
            },
            {
              chave: 'Tentativas',
              valor: `${config.agendamento.tentativas} · espera ${config.agendamento.esperasMin.join(', ')} min`,
            },
            {
              chave: 'Janela de tolerância',
              valor: `até ${config.agendamento.toleranciaAte} sem abrir incidente`,
            },
            {
              chave: 'Varredura de segurança',
              valor: `${config.agendamento.cronVarredura} (pastas pendentes)`,
            },
            {
              chave: 'Paralelismo de download',
              valor: `${config.coleta.paralelismo} arquivos`,
            },
            {
              chave: 'Alerta de volume',
              valor: `desvio maior que ${config.agendamento.desvioVolumePct}% da média 7d`,
            },
          ],
        },
        {
          titulo: 'Destino PostgreSQL',
          linhas: [
            { chave: 'Instância', valor: config.banco.instanciaRotulo },
            {
              chave: 'Banco · schema',
              valor: `${config.banco.banco} · ${config.banco.schema}`,
            },
            { chave: 'Staging', valor: 'stg_isa_infopanel_preco' },
            {
              chave: 'Fato',
              valor: 'fact_preco_coletado (particionado por mês)',
            },
            {
              chave: 'Chave de conflito',
              valor: '(gtin, id_loja, data_coleta, fonte)',
            },
            {
              chave: 'Estratégia',
              valor: 'COPY em staging + UPSERT transacional',
            },
          ],
        },
        {
          titulo: 'Alertas',
          linhas: (await q.listarRegras()).map((r) => ({
            chave: r.condicao,
            valor: `${r.canal}${r.destinatario !== '—' ? ` · ${r.destinatario}` : ''}`,
          })),
        },
      ],
      tabelas: [
        {
          nome: 'ctl_execucao',
          descricao: 'Uma linha por execução: gatilho, início, fim, status, watermark.',
        },
        {
          nome: 'ctl_arquivo',
          descricao:
            'Cada arquivo visto na origem, com hash, tamanho e horários de download e ingestão.',
        },
        {
          nome: 'ctl_execucao_log',
          descricao: 'Eventos em ordem cronológica, com nível e mensagem.',
        },
        {
          nome: 'ctl_rejeicao',
          descricao: 'Linha rejeitada, motivo, payload original e tratamento.',
        },
        {
          nome: 'stg_isa_infopanel_preco',
          descricao: 'Espelho do arquivo recebido, apagado e recarregado por run.',
        },
        {
          nome: 'fact_preco_coletado',
          descricao: 'Dado final de preço, com id_execucao e id_arquivo em cada linha.',
        },
      ],
    };

    res.json(resposta);
  }),
);

// ── Exportações ─────────────────────────────────────────────────────────────

/** Envia um CSV com BOM, para o Excel abrir com acentuação correta. */
function enviarCsv(
  res: Response,
  nome: string,
  colunas: string[],
  linhas: unknown[][],
): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.write('﻿');

  const gerador = stringify({ delimiter: ';' });
  gerador.pipe(res);
  gerador.write(colunas);
  for (const linha of linhas) gerador.write(linha);
  gerador.end();
}

rotas.get(
  '/execucoes/:id/auditoria.csv',
  rota(async (req, res) => {
    const id = Number(req.params.id);
    const execucao = await q.buscarExecucao(id);
    if (!execucao) {
      res.status(404).json({ erro: 'execução não encontrada' });
      return;
    }

    const [etapas, log, arquivos] = await Promise.all([
      q.etapasDaExecucao(id),
      q.logDaExecucao(id, 10_000),
      q.arquivosDaExecucao(id),
    ]);

    const linhas: unknown[][] = [];
    linhas.push(['execucao', execucao.id, 'run', execucao.runDate, 'status', execucao.status]);
    linhas.push([]);
    linhas.push(['seção', 'etapas']);
    for (const e of etapas) {
      linhas.push([e.ordem, e.nome, e.status, e.detalhe ?? '', duracaoBR(e.duracaoMs)]);
    }
    linhas.push([]);
    linhas.push(['seção', 'arquivos']);
    for (const a of arquivos) {
      linhas.push([
        a.nome, a.tamanhoBytes, a.sha256 ?? '', a.linhasLidas,
        a.linhasGravadas, a.linhasRejeitadas, a.status,
      ]);
    }
    linhas.push([]);
    linhas.push(['seção', 'log']);
    for (const l of log.eventos) {
      linhas.push([l.ts, l.nivel, l.mensagem]);
    }

    enviarCsv(
      res,
      `auditoria-execucao-${id}.csv`,
      ['campo', 'valor', 'campo', 'valor', 'campo', 'valor', 'campo'],
      linhas,
    );
  }),
);

rotas.get(
  '/execucoes/:id/auditoria.pdf',
  rota(async (req, res) => {
    const id = Number(req.params.id);
    const execucao = await q.buscarExecucao(id);
    if (!execucao) {
      res.status(404).json({ erro: 'execução não encontrada' });
      return;
    }

    const [etapas, log, arquivos] = await Promise.all([
      q.etapasDaExecucao(id),
      q.logDaExecucao(id, 400),
      q.arquivosDaExecucao(id),
    ]);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="auditoria-execucao-${id}.pdf"`,
    );

    const doc = new PDFDocument({ size: 'A4', margin: 44 });
    doc.pipe(res);

    doc.fontSize(16).text('Relatório de auditoria da ingestão', { align: 'left' });
    doc.moveDown(0.3);
    doc
      .fontSize(10)
      .fillColor('#555')
      .text(
        `Execução #${execucao.id} · run=${execucao.runDate} · ${q.rotuloStatus(execucao.status)}`,
      );
    doc.fillColor('#000').moveDown(0.8);

    const par = (rotulo: string, valor: string) => {
      doc.fontSize(9).fillColor('#666').text(rotulo, { continued: true });
      doc.fillColor('#000').text(`  ${valor}`);
    };

    par('Gatilho', execucao.gatilho);
    par('Tipo', execucao.tipo);
    par('Início', new Date(execucao.iniciadoEm).toLocaleString('pt-BR'));
    par(
      'Fim',
      execucao.finalizadoEm
        ? new Date(execucao.finalizadoEm).toLocaleString('pt-BR')
        : '—',
    );
    par('Duração', duracaoBR(execucao.duracaoMs));
    par('Arquivos', `${execucao.arquivosIngeridos} de ${execucao.arquivosVistos}`);
    par('Linhas em staging', numeroBR(execucao.linhasStaging));
    par(
      'Linhas gravadas',
      `${numeroBR(execucao.linhasGravadas)} (${numeroBR(execucao.linhasInseridas)} inseridas, ${numeroBR(execucao.linhasAtualizadas)} atualizadas)`,
    );
    par('Rejeições', numeroBR(execucao.linhasRejeitadas));
    par('Watermark', `${execucao.watermarkAnterior ?? '—'} → ${execucao.watermarkNovo ?? '—'}`);
    if (execucao.erro) par('Erro', execucao.erro);

    doc.moveDown(0.8).fontSize(12).text('Etapas');
    doc.moveDown(0.3).fontSize(8);
    for (const e of etapas) {
      doc.text(
        `${String(e.ordem).padStart(2, '0')} · ${e.nome} · ${e.status} · ${duracaoBR(e.duracaoMs)}`,
      );
      if (e.detalhe) doc.fillColor('#666').text(`     ${e.detalhe}`).fillColor('#000');
    }

    doc.moveDown(0.8).fontSize(12).text('Arquivos');
    doc.moveDown(0.3).fontSize(8);
    for (const a of arquivos) {
      doc.text(
        `${a.nome} · ${bytesBR(a.tamanhoBytes)} · sha ${a.sha256?.slice(0, 8) ?? '—'} · ` +
          `${numeroBR(a.linhasLidas)} lidas · ${numeroBR(a.linhasGravadas)} gravadas · ` +
          `${numeroBR(a.linhasRejeitadas)} rejeitadas`,
      );
    }

    doc.moveDown(0.8).fontSize(12).text(`Log (${log.total} eventos)`);
    doc.moveDown(0.3).fontSize(7);
    for (const l of log.eventos) {
      doc.text(
        `${new Date(l.ts).toLocaleTimeString('pt-BR')} ${l.nivel.padEnd(4)} ${l.mensagem}`,
      );
    }

    doc.end();
  }),
);

rotas.get(
  '/qualidade/rejeicoes.csv',
  rota(async (req, res) => {
    const runDate = (req.query.run as string) || dataLocal();
    const execucao = await q.execucaoDoRun(runDate);
    if (!execucao) {
      res.status(404).json({ erro: 'sem execução para o run informado' });
      return;
    }

    const linhas = await consultar<{
      arquivo: string;
      numero_linha: number;
      motivo: string;
      payload: string;
      tratamento: string;
      criado_em: string;
    }>(
      `SELECT arquivo, numero_linha, motivo, payload, tratamento, criado_em
         FROM infoprice.ctl_rejeicao
        WHERE id_execucao = $1
        ORDER BY id`,
      [execucao.id],
    );

    enviarCsv(
      res,
      `rejeicoes-${runDate}.csv`,
      ['arquivo', 'linha', 'motivo', 'payload', 'tratamento', 'registrado_em'],
      linhas.map((l) => [
        l.arquivo, l.numero_linha, l.motivo, l.payload, l.tratamento, l.criado_em,
      ]),
    );
  }),
);

rotas.get(
  '/precos.csv',
  rota(async (req, res) => {
    const { linhas } = await q.consultarPrecos({
      data: (req.query.data as string) || undefined,
      uf: (req.query.uf as string) || undefined,
      busca: (req.query.busca as string) || undefined,
      tipo: (req.query.tipo as string) || undefined,
      limite: Math.min(inteiro(req.query.limite, 10_000), 100_000),
    });

    enviarCsv(
      res,
      `precos-${(req.query.data as string) || dataLocal()}.csv`,
      [
        'gtin', 'descricao', 'loja', 'rede', 'uf', 'preco', 'preco_promocional',
        'tipo', 'data_coleta', 'execucao', 'arquivo', 'linha_no_arquivo',
      ],
      linhas.map((p) => [
        p.gtin, p.descricao, p.idLoja, p.rede ?? '', p.uf ?? '', p.preco,
        p.precoPromocional ?? '', p.tipoPreco, p.dataColeta,
        `#${p.idExecucao}`, p.arquivo, p.numeroLinha,
      ]),
    );
  }),
);
