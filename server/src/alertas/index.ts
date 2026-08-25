import type { Severidade } from '@infoprice/shared';
import { config } from '../config.js';
import { consultar, consultarUm, pool } from '../db/pool.js';
import { bytesBR, duracaoBR, numeroBR, percentualBR } from '../util/formato.js';
import { dataLocal, somarDias } from '../util/tempo.js';
import { enviarEmail } from './email.js';

export { enviarEmail } from './email.js';

interface RegraConfigurada {
  chave: string;
  condicao: string;
  severidade: Severidade;
  canal: string;
  destinatario: string;
  ativa: boolean;
}

async function regra(chave: string): Promise<RegraConfigurada | null> {
  return consultarUm<RegraConfigurada>(
    `SELECT chave, condicao, severidade, canal, destinatario, ativa
       FROM infoprice.ctl_regra_alerta WHERE chave = $1`,
    [chave],
  );
}

export interface NovoIncidente {
  chaveRegra: string;
  titulo: string;
  detalhe: string;
  idExecucao?: number | null;
  runDate?: string | null;
  /** Identidade da condição: reabrir o mesmo problema não duplica o incidente. */
  dedupe: string;
  severidade?: Severidade;
}

/**
 * Abre um incidente se ainda não houver um aberto para a mesma condição.
 * Devolve o código (#NNN) quando abriu, ou null quando já existia.
 */
export async function abrirIncidente(
  novo: NovoIncidente,
): Promise<string | null> {
  const r = await regra(novo.chaveRegra);
  if (r && !r.ativa) return null;

  const severidade = novo.severidade ?? r?.severidade ?? 'Atenção';
  const canal = r?.canal ?? 'painel';

  const linha = await consultarUm<{ id: number; codigo: string }>(
    `INSERT INTO infoprice.ctl_incidente
       (severidade, titulo, detalhe, id_execucao, run_date, canal, chave_dedupe)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chave_dedupe) WHERE status = 'aberto' AND chave_dedupe IS NOT NULL
       DO NOTHING
     RETURNING id, codigo`,
    [
      severidade,
      novo.titulo,
      novo.detalhe,
      novo.idExecucao ?? null,
      novo.runDate ?? null,
      canal,
      novo.dedupe,
    ],
  );

  if (!linha) return null;

  console.warn(`[incidente ${linha.codigo}] ${severidade} · ${novo.titulo}`);

  if (canal.includes('e-mail')) {
    await enviarEmail({
      assunto: `[InfoPrice ${severidade}] ${linha.codigo} · ${novo.titulo}`,
      texto:
        `${novo.detalhe}\n\n` +
        `Execução: ${novo.idExecucao ?? '—'}\n` +
        `Run: ${novo.runDate ?? '—'}\n` +
        `Regra: ${r?.condicao ?? novo.chaveRegra}\n`,
      destinatarios: r?.destinatario
        ? r.destinatario.split(',').map((s) => s.trim()).filter((s) => s !== '—')
        : undefined,
    });
  }

  return linha.codigo;
}

/** Fecha o incidente aberto que casa com a chave de deduplicação. */
export async function resolverPorDedupe(
  dedupe: string,
  resolucao: string,
  quem = 'sistema',
): Promise<void> {
  await pool.query(
    `UPDATE infoprice.ctl_incidente
        SET status = 'resolvido',
            resolvido_em = now(),
            resolvido_por = $2,
            resolucao = $3
      WHERE chave_dedupe = $1 AND status = 'aberto'`,
    [dedupe, quem, resolucao],
  );
}

/** Marca um incidente como resolvido a partir da tela. */
export async function resolverIncidente(
  codigo: string,
  quem: string,
  resolucao = 'Marcado como resolvido pelo painel',
): Promise<boolean> {
  const linha = await consultarUm<{ id: number }>(
    `UPDATE infoprice.ctl_incidente
        SET status = 'resolvido',
            resolvido_em = now(),
            resolvido_por = $2,
            resolucao = $3
      WHERE codigo = $1 AND status = 'aberto'
      RETURNING id`,
    [codigo, quem, resolucao],
  );
  return linha !== null;
}

/**
 * Avalia as regras que dependem do resultado da execução:
 * falha, rejeições acima do limite e desvio de volume.
 */
export async function avaliarPosExecucao(
  idExecucao: number,
  runDate: string,
): Promise<void> {
  const exec = await consultarUm<{
    status: string;
    erro: string | null;
    linhas_staging: number;
    linhas_rejeitadas: number;
    arquivos_vistos: number;
    arquivos_ingeridos: number;
  }>(
    `SELECT status, erro, linhas_staging, linhas_rejeitadas,
            arquivos_vistos, arquivos_ingeridos
       FROM infoprice.ctl_execucao WHERE id = $1`,
    [idExecucao],
  );
  if (!exec) return;

  // Falha de conexão ou execução interrompida
  if (exec.status === 'falha') {
    await abrirIncidente({
      chaveRegra: 'falha_execucao',
      titulo: 'Execução interrompida',
      detalhe:
        exec.erro ??
        'A execução terminou em falha. A transação de staging foi revertida e nada foi gravado na tabela final.',
      idExecucao,
      runDate,
      dedupe: `falha:${runDate}`,
    });
    return;
  }

  // Execução parcial: parte dos arquivos ficou de fora
  if (exec.status === 'parcial') {
    await abrirIncidente({
      chaveRegra: 'falha_execucao',
      severidade: 'Atenção',
      titulo: 'Execução parcial',
      detalhe:
        `${exec.arquivos_ingeridos} de ${exec.arquivos_vistos} arquivos foram ingeridos. ` +
        'Os demais seguem pendentes e serão retomados na próxima varredura.',
      idExecucao,
      runDate,
      dedupe: `parcial:${runDate}`,
    });
  }

  // Rejeições acima do limite
  if (exec.linhas_staging > 0) {
    const pct = (exec.linhas_rejeitadas / exec.linhas_staging) * 100;
    if (pct > config.agendamento.limiteRejeicoesPct) {
      await abrirIncidente({
        chaveRegra: 'rejeicoes_altas',
        titulo: `Rejeições em ${percentualBR(pct)}, acima do limite`,
        detalhe:
          `${numeroBR(exec.linhas_rejeitadas)} de ${numeroBR(exec.linhas_staging)} linhas ` +
          `foram retidas pelas regras de qualidade (limite de ${config.agendamento.limiteRejeicoesPct}%). ` +
          'O payload original de cada linha está em ctl_rejeicao.',
        idExecucao,
        runDate,
        dedupe: `rejeicoes:${runDate}`,
      });
    }
  }

  // Desvio de volume em relação à média de 7 dias
  const media = await consultarUm<{ media: string | null }>(
    `SELECT avg(linhas_gravadas)::numeric(14,1) AS media
       FROM infoprice.ctl_execucao
      WHERE run_date >= $1::date - INTERVAL '7 days'
        AND run_date < $1::date
        AND status = 'concluida'`,
    [runDate],
  );

  const valorMedia = media?.media ? Number(media.media) : 0;
  if (valorMedia > 0) {
    const linhas = await consultarUm<{ linhas_gravadas: number }>(
      'SELECT linhas_gravadas FROM infoprice.ctl_execucao WHERE id = $1',
      [idExecucao],
    );
    const gravadas = linhas?.linhas_gravadas ?? 0;
    const desvio = ((gravadas - valorMedia) / valorMedia) * 100;

    if (Math.abs(desvio) > config.agendamento.desvioVolumePct) {
      const sentido = desvio < 0 ? 'abaixo' : 'acima';
      await abrirIncidente({
        chaveRegra: 'desvio_volume',
        titulo: `Volume ${Math.abs(Math.round(desvio))}% ${sentido} da média de 7 dias`,
        detalhe:
          `O run trouxe ${numeroBR(gravadas)} linhas contra média de ${numeroBR(
            Math.round(valorMedia),
          )}. ` +
          (exec.arquivos_ingeridos === exec.arquivos_vistos
            ? 'Nenhum arquivo faltou, então a suspeita é de cobertura menor de lojas na origem.'
            : 'Parte dos arquivos não foi ingerida — verifique o inventário.'),
        idExecucao,
        runDate,
        dedupe: `volume:${runDate}`,
      });
    }
  }
}

/**
 * Regra "pasta do dia ausente na origem às 09:00".
 * Chamada pela varredura depois da janela de tolerância.
 */
export async function verificarPastaAusente(runDate: string): Promise<void> {
  const encontrada = await consultarUm<{ existe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM infoprice.ctl_arquivo WHERE run_date = $1
     ) AS existe`,
    [runDate],
  );

  if (encontrada?.existe) {
    await resolverPorDedupe(
      `pasta-ausente:${runDate}`,
      'Pasta apareceu na origem e foi processada',
    );
    return;
  }

  await abrirIncidente({
    chaveRegra: 'pasta_ausente',
    titulo: `Pasta run=${runDate} ausente na origem`,
    detalhe:
      `A pasta do dia não apareceu em ${config.sftp.diretorioBase} até ` +
      `${config.agendamento.toleranciaAte}. Nenhum dado novo foi gravado; ` +
      'a tabela final segue com o dado do dia anterior.',
    runDate,
    dedupe: `pasta-ausente:${runDate}`,
  });
}

/**
 * Regra "arquivo a menos de 24h da expiração na origem".
 * Informativo: aparece no painel e no resumo diário.
 */
export async function verificarExpiracao(): Promise<number> {
  const hoje = dataLocal();
  const amanha = somarDias(hoje, 1);

  const linhas = await consultar<{ pasta: string; total: number }>(
    `SELECT pasta, count(*)::bigint AS total
       FROM infoprice.ctl_arquivo
      WHERE expira_em IS NOT NULL
        AND expira_em <= $1::date
        AND expira_em >= $2::date
      GROUP BY pasta`,
    [amanha, hoje],
  );

  const total = linhas.reduce((s, l) => s + l.total, 0);
  if (total === 0) return 0;

  for (const linha of linhas) {
    const semCopia = await consultarUm<{ total: number }>(
      `SELECT count(*)::bigint AS total
         FROM infoprice.ctl_arquivo
        WHERE pasta = $1 AND (caminho_local IS NULL OR status <> 'ingerido')`,
      [linha.pasta],
    );

    await abrirIncidente({
      chaveRegra: 'arquivo_expirando',
      titulo: `Arquivos de ${linha.pasta} expiram na origem em menos de 24h`,
      detalhe:
        `${numeroBR(linha.total)} arquivos saem do servidor do fornecedor ` +
        `(retenção de ${config.coleta.retencaoOrigemDias} dias). ` +
        ((semCopia?.total ?? 0) === 0
          ? 'A cópia local já está arquivada e o hash confere, então nenhuma ação é necessária.'
          : `${numeroBR(semCopia?.total ?? 0)} ainda não têm cópia local conferida — baixe antes do prazo.`),
      dedupe: `expira:${linha.pasta}`,
    });
  }

  return total;
}

/** Resumo da execução, no painel e por e-mail. */
export async function notificarResultado(idExecucao: number): Promise<void> {
  const exec = await consultarUm<{
    id: number;
    run_date: string;
    status: string;
    arquivos_vistos: number;
    arquivos_ingeridos: number;
    bytes_baixados: number;
    linhas_staging: number;
    linhas_gravadas: number;
    linhas_inseridas: number;
    linhas_atualizadas: number;
    linhas_rejeitadas: number;
    erro: string | null;
    duracao_ms: number | null;
  }>(
    `SELECT id, run_date, status, arquivos_vistos, arquivos_ingeridos,
            bytes_baixados, linhas_staging, linhas_gravadas, linhas_inseridas,
            linhas_atualizadas, linhas_rejeitadas, erro,
            (EXTRACT(EPOCH FROM (COALESCE(finalizado_em, now()) - iniciado_em)) * 1000)::bigint AS duracao_ms
       FROM infoprice.ctl_execucao WHERE id = $1`,
    [idExecucao],
  );
  if (!exec) return;

  const titulo =
    exec.status === 'concluida'
      ? 'Coleta concluída'
      : exec.status === 'parcial'
        ? 'Coleta parcial'
        : 'Coleta falhou';

  const corpo = [
    `Execução #${exec.id} · run=${exec.run_date}`,
    `Status: ${titulo}`,
    `Duração: ${duracaoBR(exec.duracao_ms)}`,
    `Arquivos: ${exec.arquivos_ingeridos} de ${exec.arquivos_vistos} · ${bytesBR(exec.bytes_baixados)}`,
    `Linhas em staging: ${numeroBR(exec.linhas_staging)}`,
    `Linhas gravadas: ${numeroBR(exec.linhas_gravadas)} ` +
      `(${numeroBR(exec.linhas_inseridas)} inseridas, ${numeroBR(exec.linhas_atualizadas)} atualizadas)`,
    `Rejeições: ${numeroBR(exec.linhas_rejeitadas)}`,
    exec.erro ? `\nErro: ${exec.erro}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // A falha já gerou um e-mail de incidente; aqui evitamos mandar dois.
  if (exec.status !== 'falha') {
    await enviarEmail({
      assunto: `[InfoPrice] ${titulo} · run=${exec.run_date}`,
      texto: corpo,
    });
  }
}

/** Resumo diário das 06:00. */
export async function enviarResumoDiario(): Promise<void> {
  const hoje = dataLocal();
  const exec = await consultarUm<{
    id: number;
    status: string;
    linhas_gravadas: number;
    linhas_rejeitadas: number;
    arquivos_ingeridos: number;
    arquivos_vistos: number;
  }>(
    `SELECT id, status, linhas_gravadas, linhas_rejeitadas,
            arquivos_ingeridos, arquivos_vistos
       FROM infoprice.ctl_execucao
      WHERE run_date = $1
      ORDER BY id DESC LIMIT 1`,
    [hoje],
  );

  const abertos = await consultarUm<{ total: number }>(
    `SELECT count(*)::bigint AS total FROM infoprice.ctl_incidente WHERE status = 'aberto'`,
  );

  const linhas = exec
    ? [
        `Execução #${exec.id} · ${exec.status}`,
        `Arquivos: ${exec.arquivos_ingeridos}/${exec.arquivos_vistos}`,
        `Linhas gravadas: ${numeroBR(exec.linhas_gravadas)}`,
        `Rejeições: ${numeroBR(exec.linhas_rejeitadas)}`,
      ]
    : ['Nenhuma execução registrada para hoje.'];

  linhas.push(`Incidentes abertos: ${abertos?.total ?? 0}`);

  await enviarEmail({
    assunto: `[InfoPrice] Resumo diário · ${hoje}`,
    texto: linhas.join('\n'),
    destinatarios: config.alertas.resumoDestinatarios,
  });
}
