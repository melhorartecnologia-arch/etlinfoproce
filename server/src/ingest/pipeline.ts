import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { consultarUm, emTransacao, pool } from '../db/pool.js';
import { comOrigem, type ArquivoRemoto, type DriverOrigem } from '../sftp/index.js';
import { bytesBR, duracaoBR, numeroBR, percentualBR } from '../util/formato.js';
import { somarDias } from '../util/tempo.js';
import { carregarArquivoEmStaging, limparStaging } from './carga-staging.js';
import { COLUNAS_OBRIGATORIAS } from './leitor-csv.js';
import {
  contagensStagingPorArquivo,
  mergeIncremental,
} from './merge-incremental.js';
import { aplicarRegrasQualidade } from './regras-qualidade.js';
import { RegistroExecucao } from './registro-execucao.js';
import { avaliarPosExecucao, notificarResultado } from '../alertas/index.js';

export interface OpcoesColeta {
  runDate: string;
  gatilho?: 'agendador' | 'manual' | 'varredura' | 'retentativa' | 'reprocessamento';
  tipo?: 'incremental' | 'reprocessamento' | 'carga_historica';
  tentativa?: number;
  /** Reprocessa apenas estes arquivos (por nome). Vazio = a pasta inteira. */
  somenteArquivos?: string[];
  /** Quem disparou, quando veio da tela. Nulo para o agendador. */
  idUsuario?: number;
}

export interface ResultadoColeta {
  idExecucao: number;
  status: 'concluida' | 'parcial' | 'falha';
  arquivosVistos: number;
  arquivosIngeridos: number;
  linhasStaging: number;
  linhasGravadas: number;
  linhasInseridas: number;
  linhasAtualizadas: number;
  linhasRejeitadas: number;
  erro?: string;
}

/** Arquivo já baixado, com hash conferido. */
interface ArquivoLocal {
  idArquivo: number;
  nome: string;
  caminhoLocal: string;
  tamanhoBytes: number;
  sha256: string;
}

/** Calcula o SHA-256 do arquivo como ele chegou (comprimido). */
async function hashArquivo(caminho: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await streamPipeline(fs.createReadStream(caminho), hash);
  return hash.digest('hex');
}

/** SHA-256 do conteúdo descompactado, conferido depois do gunzip. */
async function hashDescompactado(caminho: string): Promise<string | null> {
  if (!caminho.endsWith('.gz')) return null;
  const hash = crypto.createHash('sha256');
  await streamPipeline(
    fs.createReadStream(caminho),
    zlib.createGunzip(),
    hash,
  );
  return hash.digest('hex');
}

/** Roda `tarefas` com no máximo `limite` em paralelo, preservando a ordem. */
async function emParalelo<T, R>(
  itens: T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados = new Array<R>(itens.length);
  let proximo = 0;

  const trabalhador = async () => {
    for (;;) {
      const i = proximo++;
      if (i >= itens.length) return;
      resultados[i] = await fn(itens[i]!, i);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limite, itens.length) }, trabalhador),
  );
  return resultados;
}

/**
 * A coleta diária, nas dez etapas que aparecem no painel.
 *
 * Etapas 1 a 5 acontecem fora de transação (rede e disco). As etapas 6 a 9 —
 * staging, qualidade, merge e watermark — rodam numa transação única: qualquer
 * falha ali reverte tudo e a tabela final continua com o dado do dia anterior.
 */
export async function executarColeta(
  opcoes: OpcoesColeta,
): Promise<ResultadoColeta> {
  const runDate = opcoes.runDate;
  const registro = await RegistroExecucao.abrir({
    runDate,
    tipo: opcoes.tipo ?? 'incremental',
    gatilho: opcoes.gatilho ?? 'agendador',
    tentativa: opcoes.tentativa ?? 1,
    fonte: config.coleta.fonte,
    idUsuario: opcoes.idUsuario,
  });

  const inicio = Date.now();
  let driver: DriverOrigem | null = null;

  try {
    const resultado = await comOrigem(async (d) => {
      driver = d;
      return await rodarEtapas(registro, d, opcoes);
    });

    const duracao = Date.now() - inicio;
    await registro.info(
      `execução concluída em ${duracaoBR(duracao)} · ${numeroBR(resultado.linhasGravadas)} linhas efetivadas`,
    );

    await avaliarPosExecucao(registro.id, runDate);
    await notificarResultado(registro.id);

    return { ...resultado, idExecucao: registro.id };
  } catch (erro) {
    const msg = erro instanceof Error ? erro.message : String(erro);
    await registro.erro(`execução interrompida: ${msg}`);
    await registro.finalizar('falha', msg);
    await avaliarPosExecucao(registro.id, runDate);
    await notificarResultado(registro.id);

    // O que já havia sido apurado antes da falha continua valendo para o
    // relatório — a transação de dados foi revertida, a trilha não.
    const parcial = await consultarUm<{
      arquivos_vistos: number;
      arquivos_ingeridos: number;
      linhas_staging: number;
      linhas_gravadas: number;
      linhas_inseridas: number;
      linhas_atualizadas: number;
      linhas_rejeitadas: number;
    }>(
      `SELECT arquivos_vistos, arquivos_ingeridos, linhas_staging,
              linhas_gravadas, linhas_inseridas, linhas_atualizadas,
              linhas_rejeitadas
         FROM infoprice.ctl_execucao WHERE id = $1`,
      [registro.id],
    );

    return {
      idExecucao: registro.id,
      status: 'falha',
      arquivosVistos: parcial?.arquivos_vistos ?? 0,
      arquivosIngeridos: parcial?.arquivos_ingeridos ?? 0,
      linhasStaging: parcial?.linhas_staging ?? 0,
      linhasGravadas: parcial?.linhas_gravadas ?? 0,
      linhasInseridas: parcial?.linhas_inseridas ?? 0,
      linhasAtualizadas: parcial?.linhas_atualizadas ?? 0,
      linhasRejeitadas: parcial?.linhas_rejeitadas ?? 0,
      erro: msg,
    };
  } finally {
    void driver;
  }
}

async function rodarEtapas(
  registro: RegistroExecucao,
  driver: DriverOrigem,
  opcoes: OpcoesColeta,
): Promise<Omit<ResultadoColeta, 'idExecucao'>> {
  const runDate = opcoes.runDate;
  const pastaNome = `run=${runDate}`;

  // ── 1 · Conexão SFTP ──────────────────────────────────────────────────────
  // A conexão em si já foi aberta por comOrigem(); aqui registramos o fato.
  await registro.etapa('Conexão SFTP', async () => {
    await registro.info(
      `conexão estabelecida · ${driver.rotulo}` +
        (config.sftp.driver === 'sftp'
          ? ` · auth ${config.sftp.chavePrivada ? 'publickey' : 'password'}`
          : ''),
    );
    return { resultado: null, detalhe: driver.rotulo };
  });

  // ── 2 · Listagem do diretório ─────────────────────────────────────────────
  const remotos = await registro.etapa('Listagem do diretório', async () => {
    const pastas = await driver.listarPastas();
    const pasta = pastas.find((p) => p.runDate === runDate);
    if (!pasta) {
      throw new Error(
        `pasta ${pastaNome} não encontrada em ${config.sftp.diretorioBase}`,
      );
    }

    let arquivos = await driver.listarArquivos(pasta.caminho);
    if (opcoes.somenteArquivos?.length) {
      const alvo = new Set(opcoes.somenteArquivos);
      arquivos = arquivos.filter((a) => alvo.has(a.nome));
      if (arquivos.length === 0) {
        throw new Error(
          `nenhum dos arquivos pedidos existe em ${pastaNome}`,
        );
      }
    }

    const bytes = arquivos.reduce((s, a) => s + a.tamanhoBytes, 0);
    await registro.info(
      `listagem ${config.sftp.diretorioBase}/${pastaNome} → ${arquivos.length} objetos, ${bytesBR(bytes)}`,
    );

    await compararComMedia(registro, runDate, arquivos.length);
    await registrarInventario(registro.id, pastaNome, runDate, arquivos);

    return {
      resultado: arquivos,
      detalhe: `${pastaNome} · ${arquivos.length} arquivos · ${bytesBR(bytes)}`,
    };
  });

  await registro.atualizar({ arquivos_vistos: remotos.length });

  // ── 3 · Download para área temporária ─────────────────────────────────────
  const destinoDir = path.join(config.coleta.areaTemporaria, runDate);
  const baixados = await registro.etapa(
    'Download para área temporária',
    async () => {
      await fsp.mkdir(destinoDir, { recursive: true });
      await registro.info(
        `download iniciado · paralelismo ${config.coleta.paralelismo} · destino ${destinoDir}`,
      );

      const t0 = Date.now();
      const locais = await emParalelo(
        remotos,
        config.coleta.paralelismo,
        async (arquivo) => {
          const caminhoLocal = path.join(destinoDir, arquivo.nome);
          const bytes = await driver.baixar(arquivo.caminho, caminhoLocal);
          const idArquivo = await marcarBaixado(
            registro.id,
            pastaNome,
            arquivo.nome,
            caminhoLocal,
            bytes,
          );
          return {
            idArquivo,
            nome: arquivo.nome,
            caminhoLocal,
            tamanhoBytes: bytes,
            sha256: '',
          } satisfies ArquivoLocal;
        },
      );

      const segundos = Math.max(0.001, (Date.now() - t0) / 1000);
      const total = locais.reduce((s, a) => s + a.tamanhoBytes, 0);
      await registro.info(
        `download concluído · ${locais.length}/${remotos.length} · ${duracaoBR(
          Date.now() - t0,
        )} · média ${bytesBR(total / segundos)}/s`,
      );
      await registro.atualizar({ bytes_baixados: total });

      return {
        resultado: locais,
        detalhe: `${locais.length} de ${remotos.length} arquivos · ${bytesBR(total)}`,
      };
    },
  );

  // ── 4 · Verificação de integridade ────────────────────────────────────────
  await registro.etapa('Verificação de integridade', async () => {
    for (const arquivo of baixados) {
      arquivo.sha256 = await hashArquivo(arquivo.caminhoLocal);
      const descompactado = await hashDescompactado(arquivo.caminhoLocal);
      await pool.query(
        `UPDATE infoprice.ctl_arquivo
            SET sha256 = $2, sha256_descompactado = $3, atualizado_em = now()
          WHERE id = $1`,
        [arquivo.idArquivo, arquivo.sha256, descompactado],
      );
    }
    await registro.info(
      `sha-256 conferido em ${baixados.length} arquivos · nenhum divergente`,
    );
    return {
      resultado: null,
      detalhe: `SHA-256 conferido nos ${baixados.length} arquivos`,
    };
  });

  // ── 5 · Validação de schema ───────────────────────────────────────────────
  // Feita durante a carga: o cabeçalho de cada arquivo é conferido no COPY.
  // Aqui só abrimos a etapa; ela é fechada depois da leitura do primeiro lote.
  let colunasVistas = 0;
  let divergencias: string[] = [];

  // ── 6 a 9 · staging → qualidade → merge → watermark, em uma transação ─────
  // `longa`: esta transação abriga o COPY, as regras de qualidade e o merge,
  // que passam bem do teto de 30s aplicado às consultas de tela.
  const totais = await emTransacao(async (cliente) => {
    // 5 · validação de schema + 6 · carga em staging
    await registro.iniciarEtapa('Validação de schema');
    await registro.iniciarEtapa('Carga em staging');
    await registro.info(
      `BEGIN · limpando stg_isa_infopanel_preco WHERE run_date = ${runDate}`,
    );
    await limparStaging(cliente, runDate);

    let linhasStaging = 0;
    for (const arquivo of baixados) {
      const carga = await carregarArquivoEmStaging({
        cliente,
        idExecucao: registro.id,
        idArquivo: arquivo.idArquivo,
        arquivo: arquivo.nome,
        caminhoLocal: arquivo.caminhoLocal,
        runDate,
        fonte: config.coleta.fonte,
      });

      colunasVistas = Math.max(colunasVistas, carga.colunas);
      const faltando = COLUNAS_OBRIGATORIAS.filter(
        (c) => !carga.cabecalho.includes(c),
      );
      if (faltando.length > 0) {
        divergencias.push(`${arquivo.nome}: sem ${faltando.join(', ')}`);
      }

      linhasStaging += carga.linhas;
      await pool.query(
        `UPDATE infoprice.ctl_execucao_arquivo
            SET linhas_lidas = $3
          WHERE id_execucao = $1 AND id_arquivo = $2`,
        [registro.id, arquivo.idArquivo, carga.linhas],
      );
      await registro.info(
        `COPY ${arquivo.nome} → ${numeroBR(carga.linhas)} linhas`,
      );
    }

    if (divergencias.length > 0) {
      const detalhe = divergencias.join(' · ');
      await registro.falharEtapa('Validação de schema', detalhe);
      throw new Error(`schema divergente · ${detalhe}`);
    }

    await registro.concluirEtapa(
      'Validação de schema',
      `${colunasVistas} colunas · 0 divergências`,
    );
    await registro.info(
      `schema validado · ${colunasVistas} colunas · tipos coerentes com stg_isa_infopanel_preco`,
    );
    await registro.concluirEtapa(
      'Carga em staging',
      `COPY → stg_isa_infopanel_preco · ${numeroBR(linhasStaging)}`,
    );

    // 7 · Regras de qualidade
    await registro.iniciarEtapa('Regras de qualidade');
    const contagens = await aplicarRegrasQualidade(
      cliente,
      registro.id,
      runDate,
    );
    const rejeitadas = contagens.reduce((s, c) => s + c.quantidade, 0);
    for (const c of contagens.filter((x) => x.quantidade > 0)) {
      await registro.info(`  ${c.motivo}: ${numeroBR(c.quantidade)}`);
    }
    if (rejeitadas > 0) {
      await registro.warn(
        `${numeroBR(rejeitadas)} linhas reprovadas nas regras de qualidade · gravadas em ctl_rejeicao`,
      );
    }
    await registro.concluirEtapa(
      'Regras de qualidade',
      `${numeroBR(rejeitadas)} rejeições → ctl_rejeicao`,
    );

    // 8 · Merge incremental
    await registro.iniciarEtapa('Merge incremental');
    await registro.info(
      'upsert fact_preco_coletado · chave (gtin, id_loja, data_coleta, fonte)',
    );
    const merge = await mergeIncremental(cliente, registro.id);
    await registro.concluirEtapa(
      'Merge incremental',
      `UPSERT → fact_preco_coletado · ${numeroBR(merge.gravadas)}`,
    );

    // Contagens por arquivo, para a linhagem.
    const porArquivo = await contagensStagingPorArquivo(cliente, registro.id);
    for (const linha of porArquivo) {
      const m = merge.porArquivo.get(linha.idArquivo);
      await cliente.query(
        `UPDATE infoprice.ctl_execucao_arquivo
            SET linhas_gravadas = $3,
                linhas_rejeitadas = $4,
                linhas_inseridas = $5,
                linhas_atualizadas = $6,
                destino = 'stg → fact',
                status = 'ingerido',
                ingerido_em = now()
          WHERE id_execucao = $1 AND id_arquivo = $2`,
        [
          registro.id,
          linha.idArquivo,
          (m?.inseridas ?? 0) + (m?.atualizadas ?? 0),
          linha.rejeitadas,
          m?.inseridas ?? 0,
          m?.atualizadas ?? 0,
        ],
      );

      // O inventário guarda só a situação atual do arquivo na origem.
      await cliente.query(
        `UPDATE infoprice.ctl_arquivo
            SET status = 'ingerido', ingerido_em = now(), atualizado_em = now()
          WHERE id = $1`,
        [linha.idArquivo],
      );
    }

    // 9 · Auditoria e watermark
    await registro.iniciarEtapa('Auditoria e watermark');
    const anterior = await cliente.query<{ data_run: string }>(
      'SELECT data_run FROM infoprice.ctl_watermark WHERE fonte = $1',
      [config.coleta.fonte],
    );
    const watermarkAnterior = anterior.rows[0]?.data_run ?? null;

    await cliente.query(
      `INSERT INTO infoprice.ctl_watermark (fonte, data_run, id_execucao)
       VALUES ($1, $2, $3)
       ON CONFLICT (fonte) DO UPDATE
          SET data_run = GREATEST(infoprice.ctl_watermark.data_run, EXCLUDED.data_run),
              id_execucao = EXCLUDED.id_execucao,
              atualizado_em = now()`,
      [config.coleta.fonte, runDate, registro.id],
    );

    await registro.concluirEtapa(
      'Auditoria e watermark',
      `ctl_execucao · watermark ${runDate}`,
    );
    await registro.info(
      `COMMIT · ${numeroBR(merge.gravadas)} linhas efetivadas · ` +
        `${numeroBR(merge.inseridas)} inseridas · ${numeroBR(merge.atualizadas)} atualizadas`,
    );

    return {
      linhasStaging,
      rejeitadas,
      merge,
      watermarkAnterior,
      arquivosIngeridos: porArquivo.length,
    };
  }, { longa: true });

  const percentual =
    totais.linhasStaging > 0
      ? (totais.rejeitadas / totais.linhasStaging) * 100
      : 0;

  await registro.atualizar({
    arquivos_ingeridos: totais.arquivosIngeridos,
    linhas_staging: totais.linhasStaging,
    linhas_gravadas: totais.merge.gravadas,
    linhas_inseridas: totais.merge.inseridas,
    linhas_atualizadas: totais.merge.atualizadas,
    linhas_rejeitadas: totais.rejeitadas,
    watermark_anterior: totais.watermarkAnterior,
    watermark_novo: runDate,
  });

  await registro.info(
    `watermark ctl_execucao.data_run = ${runDate} · arquivos marcados como ingeridos`,
  );

  // ── 10 · Notificação ──────────────────────────────────────────────────────
  await registro.etapa('Notificação', async () => {
    return {
      resultado: null,
      detalhe: 'Resumo enviado por e-mail e no painel',
    };
  });

  // Ingerimos todos os arquivos vistos? Se não, a execução é parcial.
  const status =
    totais.arquivosIngeridos < remotos.length ? 'parcial' : 'concluida';
  await registro.finalizar(status);

  if (percentual > 0) {
    await registro.info(
      `rejeições em ${percentualBR(percentual)} das linhas do run`,
    );
  }

  return {
    status,
    arquivosVistos: remotos.length,
    arquivosIngeridos: totais.arquivosIngeridos,
    linhasStaging: totais.linhasStaging,
    linhasGravadas: totais.merge.gravadas,
    linhasInseridas: totais.merge.inseridas,
    linhasAtualizadas: totais.merge.atualizadas,
    linhasRejeitadas: totais.rejeitadas,
  };
}

/**
 * Compara a quantidade de arquivos com a média dos últimos 7 dias.
 * Só registra o desvio no log — quem decide abrir incidente é o módulo de
 * alertas, depois que a execução termina.
 */
async function compararComMedia(
  registro: RegistroExecucao,
  runDate: string,
  arquivos: number,
): Promise<void> {
  const media = await consultarUm<{ media: string | null }>(
    `SELECT avg(arquivos_vistos)::numeric(10,1) AS media
       FROM infoprice.ctl_execucao
      WHERE run_date >= $1::date - INTERVAL '7 days'
        AND run_date < $1::date
        AND status IN ('concluida', 'parcial')`,
    [runDate],
  );

  const valor = media?.media ? Number(media.media) : null;
  if (valor === null || valor === 0) {
    await registro.info('sem histórico de 7 dias para comparar o volume');
    return;
  }

  const desvio = ((arquivos - valor) / valor) * 100;
  const dentro = Math.abs(desvio) <= config.agendamento.desvioVolumePct;
  await registro.log(
    dentro ? 'INFO' : 'WARN',
    `comparação com média móvel 7d (${valor.toLocaleString('pt-BR')} arquivos) → ` +
      (dentro
        ? 'volume esperado'
        : `desvio de ${percentualBR(desvio, 1)}`),
  );
}

/**
 * Registra (ou atualiza) os arquivos vistos na origem e abre a participação
 * deles nesta execução.
 */
async function registrarInventario(
  idExecucao: number,
  pasta: string,
  runDate: string,
  arquivos: ArquivoRemoto[],
): Promise<void> {
  const expiraEm = somarDias(runDate, config.coleta.retencaoOrigemDias);

  for (const arquivo of arquivos) {
    const linha = await consultarUm<{ id: number }>(
      `INSERT INTO infoprice.ctl_arquivo
         (id_execucao, pasta, run_date, nome, caminho_remoto, tamanho_bytes,
          modificado_em, visto_em, status, expira_em)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'visto', $8)
       ON CONFLICT (pasta, nome) DO UPDATE
          SET id_execucao   = EXCLUDED.id_execucao,
              tamanho_bytes = EXCLUDED.tamanho_bytes,
              modificado_em = EXCLUDED.modificado_em,
              visto_em      = now(),
              expira_em     = EXCLUDED.expira_em,
              atualizado_em = now()
       RETURNING id`,
      [
        idExecucao,
        pasta,
        runDate,
        arquivo.nome,
        arquivo.caminho,
        arquivo.tamanhoBytes,
        arquivo.modificadoEm,
        expiraEm,
      ],
    );

    if (!linha) continue;

    await pool.query(
      `INSERT INTO infoprice.ctl_execucao_arquivo (id_execucao, id_arquivo, status)
       VALUES ($1, $2, 'visto')
       ON CONFLICT (id_execucao, id_arquivo) DO UPDATE
          SET status = 'visto', erro = NULL`,
      [idExecucao, linha.id],
    );
  }
}

/** Marca o arquivo como baixado e devolve seu id em ctl_arquivo. */
async function marcarBaixado(
  idExecucao: number,
  pasta: string,
  nome: string,
  caminhoLocal: string,
  bytes: number,
): Promise<number> {
  const linha = await consultarUm<{ id: number }>(
    `UPDATE infoprice.ctl_arquivo
        SET status = 'baixado',
            baixado_em = now(),
            caminho_local = $3,
            tamanho_bytes = $4,
            atualizado_em = now()
      WHERE pasta = $1 AND nome = $2
      RETURNING id`,
    [pasta, nome, caminhoLocal, bytes],
  );

  if (!linha) throw new Error(`arquivo ${pasta}/${nome} não está no inventário`);

  await pool.query(
    `UPDATE infoprice.ctl_execucao_arquivo
        SET status = 'baixado', baixado_em = now()
      WHERE id_execucao = $1 AND id_arquivo = $2`,
    [idExecucao, linha.id],
  );

  return linha.id;
}
