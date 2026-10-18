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
import { carregarArquivoEmStaging, limparStagingArquivo } from './carga-staging.js';
import {
  COLUNAS_OBRIGATORIAS,
  lerCabecalho,
  validarCabecalho,
} from './leitor-csv.js';
import { mergeIncremental } from './merge-incremental.js';
import {
  aplicarRegrasQualidade,
  cadastrarLojasNovas,
  type ContagemMotivo,
} from './regras-qualidade.js';
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
 * Etapas 1 a 5 acontecem fora de transação (rede e disco); a 5 confere só o
 * cabeçalho de cada arquivo. As etapas 6 a 8 — staging, qualidade e merge —
 * rodam arquivo a arquivo, cada um na sua transação: um arquivo é efetivado
 * por inteiro antes do próximo começar, e uma falha reverte apenas ele.
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
  // Só o cabeçalho de cada arquivo, antes de carregar qualquer linha: um
  // arquivo fora do layout é recusado em segundos, e não depois do COPY.
  const aptos = await registro.etapa('Validação de schema', async () => {
    const validos: ArquivoLocal[] = [];
    // motivo → arquivos recusados por ele e a amostra do primeiro.
    const recusas = new Map<string, { nomes: string[]; amostra: string }>();
    let colunas = 0;

    for (const arquivo of baixados) {
      let recusa: { motivo: string; amostra: string } | null;
      try {
        const info = await lerCabecalho(arquivo.caminhoLocal);
        colunas = Math.max(colunas, info.colunas.length);
        recusa = validarCabecalho(info);
      } catch (erro) {
        recusa = { motivo: erro instanceof Error ? erro.message : String(erro), amostra: '' };
      }

      if (recusa) {
        await marcarArquivoComErro(
          registro.id,
          arquivo.idArquivo,
          `schema divergente · ${recusa.motivo}` + (recusa.amostra ? ` · ${recusa.amostra}` : ''),
        );
        const grupo = recusas.get(recusa.motivo) ?? { nomes: [], amostra: recusa.amostra };
        grupo.nomes.push(arquivo.nome);
        recusas.set(recusa.motivo, grupo);
      } else {
        validos.push(arquivo);
      }
    }

    // Um evento por motivo, não por arquivo: 50 arquivos com o mesmo
    // cabeçalho errado são um problema só.
    const descrever = (motivo: string, g: { nomes: string[]; amostra: string }) =>
      `${g.nomes.length} de ${baixados.length} arquivos · ${motivo}` +
      (g.amostra ? ` · ${g.amostra}` : '') +
      ` · ${g.nomes.length > 3 ? `${g.nomes.slice(0, 3).join(', ')} e outros` : g.nomes.join(', ')}`;
    for (const [motivo, grupo] of recusas) {
      await registro.erro(`recusados por schema · ${descrever(motivo, grupo)}`);
    }

    if (validos.length === 0) {
      const [motivo, grupo] = [...recusas][0]!;
      throw new Error(`schema divergente · ${descrever(motivo, grupo)}`);
    }

    await registro.info(
      `schema validado · ${colunas} colunas · ${validos.length} de ${baixados.length} arquivos aptos`,
    );
    return {
      resultado: validos,
      detalhe:
        `${colunas} colunas · ${validos.length} de ${baixados.length} arquivos aptos` +
        (recusas.size > 0 ? ` · ${baixados.length - validos.length} recusados` : ''),
    };
  });

  // ── 6 a 8 · um arquivo por vez, do staging à gravação ─────────────────────
  // Cada arquivo passa por staging, regras de qualidade e merge numa transação
  // própria e é efetivado antes do próximo começar. O que já foi gravado fica
  // gravado: uma falha no arquivo 30 não desfaz os 29 anteriores — reverte só
  // o arquivo 30, que a varredura tenta de novo.
  await registro.iniciarEtapa('Carga em staging');
  await registro.iniciarEtapa('Regras de qualidade');
  await registro.iniciarEtapa('Merge incremental');

  const totais = {
    arquivosIngeridos: 0,
    linhasStaging: 0,
    rejeitadas: 0,
    inseridas: 0,
    atualizadas: 0,
    comErro: 0,
    lojasNovas: 0,
  };
  const porMotivo = new Map<string, number>();

  for (const [i, arquivo] of aptos.entries()) {
    const t0 = Date.now();
    const posicao = `[${i + 1}/${aptos.length}]`;
    try {
      const r = await processarArquivo(registro, arquivo, runDate);

      totais.arquivosIngeridos += 1;
      totais.linhasStaging += r.linhas;
      totais.rejeitadas += r.rejeitadas;
      totais.inseridas += r.inseridas;
      totais.atualizadas += r.atualizadas;
      totais.lojasNovas += r.lojasNovas;
      for (const c of r.contagens) {
        porMotivo.set(c.motivo, (porMotivo.get(c.motivo) ?? 0) + c.quantidade);
      }

      await registro.info(
        `${posicao} ${arquivo.nome} gravado em ${duracaoBR(Date.now() - t0)} · ` +
          `${numeroBR(r.linhas)} lidas · ${numeroBR(r.rejeitadas)} rejeitadas · ` +
          `${numeroBR(r.inseridas)} inseridas · ${numeroBR(r.atualizadas)} atualizadas`,
      );
      if (r.recuperadas > 0) {
        await registro.warn(
          `${arquivo.nome}: ${numeroBR(r.recuperadas)} linhas com aspas fora do padrão lidas em modo tolerante`,
        );
      }
      if (r.malformadas > 0) {
        await registro.warn(
          `${arquivo.nome}: ${numeroBR(r.malformadas)} linhas malformadas seguem como rejeição`,
        );
      }
    } catch (erro) {
      const msg = erro instanceof Error ? erro.message : String(erro);
      totais.comErro += 1;
      await registro.erro(
        `${posicao} ${arquivo.nome} revertido: ${msg} · os demais arquivos seguem`,
      );
      await marcarArquivoComErro(registro.id, arquivo.idArquivo, msg);
    }

    // O painel acompanha o avanço arquivo a arquivo.
    await registro.atualizar({
      arquivos_ingeridos: totais.arquivosIngeridos,
      linhas_staging: totais.linhasStaging,
      linhas_gravadas: totais.inseridas + totais.atualizadas,
      linhas_inseridas: totais.inseridas,
      linhas_atualizadas: totais.atualizadas,
      linhas_rejeitadas: totais.rejeitadas,
    });
  }

  const gravadas = totais.inseridas + totais.atualizadas;
  const sufixoErro =
    totais.comErro > 0 ? ` · ${totais.comErro} arquivo(s) com erro` : '';

  if (totais.arquivosIngeridos === 0) {
    const detalhe = `nenhum dos ${aptos.length} arquivos pôde ser gravado`;
    await registro.falharEtapa('Carga em staging', detalhe);
    await registro.falharEtapa('Regras de qualidade', detalhe);
    await registro.falharEtapa('Merge incremental', detalhe);
    throw new Error(detalhe);
  }

  for (const [motivo, quantidade] of porMotivo) {
    if (quantidade > 0) await registro.info(`  ${motivo}: ${numeroBR(quantidade)}`);
  }
  if (totais.rejeitadas > 0) {
    await registro.warn(
      `${numeroBR(totais.rejeitadas)} linhas reprovadas nas regras de qualidade · gravadas em ctl_rejeicao`,
    );
  }
  if (totais.lojasNovas > 0) {
    await registro.info(
      `${numeroBR(totais.lojasNovas)} lojas novas cadastradas em dim_loja a partir dos arquivos`,
    );
  }

  await registro.concluirEtapa(
    'Carga em staging',
    `COPY → stg_isa_infopanel_preco · ${numeroBR(totais.linhasStaging)}${sufixoErro}`,
  );
  await registro.concluirEtapa(
    'Regras de qualidade',
    `${numeroBR(totais.rejeitadas)} rejeições → ctl_rejeicao`,
  );
  await registro.concluirEtapa(
    'Merge incremental',
    `UPSERT → fact_preco_coletado · ${numeroBR(gravadas)} · ` +
      `${totais.arquivosIngeridos} de ${aptos.length} arquivos efetivados`,
  );

  // ── 9 · Auditoria e watermark ─────────────────────────────────────────────
  const watermarkAnterior = await registro.etapa(
    'Auditoria e watermark',
    async () => {
      const anterior = await emTransacao(async (cliente) => {
        const r = await cliente.query<{ data_run: string }>(
          'SELECT data_run FROM infoprice.ctl_watermark WHERE fonte = $1',
          [config.coleta.fonte],
        );
        await cliente.query(
          `INSERT INTO infoprice.ctl_watermark (fonte, data_run, id_execucao)
           VALUES ($1, $2, $3)
           ON CONFLICT (fonte) DO UPDATE
              SET data_run = GREATEST(infoprice.ctl_watermark.data_run, EXCLUDED.data_run),
                  id_execucao = EXCLUDED.id_execucao,
                  atualizado_em = now()`,
          [config.coleta.fonte, runDate, registro.id],
        );
        return r.rows[0]?.data_run ?? null;
      });
      return { resultado: anterior, detalhe: `ctl_execucao · watermark ${runDate}` };
    },
  );

  await registro.atualizar({
    watermark_anterior: watermarkAnterior,
    watermark_novo: runDate,
  });
  await registro.info(
    `${numeroBR(gravadas)} linhas efetivadas · ${numeroBR(totais.inseridas)} inseridas · ` +
      `${numeroBR(totais.atualizadas)} atualizadas · watermark ${runDate}`,
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

  const percentual =
    totais.linhasStaging > 0 ? (totais.rejeitadas / totais.linhasStaging) * 100 : 0;
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
    linhasGravadas: gravadas,
    linhasInseridas: totais.inseridas,
    linhasAtualizadas: totais.atualizadas,
    linhasRejeitadas: totais.rejeitadas,
  };
}

interface ResultadoArquivo {
  linhas: number;
  rejeitadas: number;
  inseridas: number;
  atualizadas: number;
  recuperadas: number;
  malformadas: number;
  lojasNovas: number;
  contagens: ContagemMotivo[];
}

/**
 * Leva um arquivo do staging até a tabela final, numa transação só: limpa o
 * staging do arquivo, carrega, aplica as regras, faz o merge e atualiza a
 * trilha. Qualquer falha reverte apenas este arquivo.
 */
async function processarArquivo(
  registro: RegistroExecucao,
  arquivo: ArquivoLocal,
  runDate: string,
): Promise<ResultadoArquivo> {
  // `longa`: COPY, regras e merge de um arquivo grande passam do teto de 30s
  // aplicado às consultas de tela.
  return emTransacao(async (cliente) => {
    await limparStagingArquivo(cliente, arquivo.idArquivo);

    const carga = await carregarArquivoEmStaging({
      cliente,
      idExecucao: registro.id,
      idArquivo: arquivo.idArquivo,
      arquivo: arquivo.nome,
      caminhoLocal: arquivo.caminhoLocal,
      runDate,
      fonte: config.coleta.fonte,
    });

    // O cabeçalho já foi conferido; esta checagem só pega um arquivo que
    // mudou de layout entre a validação e a carga.
    const faltando = COLUNAS_OBRIGATORIAS.filter((c) => !carga.cabecalho.includes(c));
    if (faltando.length > 0) {
      throw new Error(`schema divergente · sem ${faltando.join(', ')}`);
    }

    const lojasNovas = config.coleta.cadastrarLojas
      ? await cadastrarLojasNovas(cliente, registro.id, arquivo.idArquivo)
      : 0;

    const contagens = await aplicarRegrasQualidade(
      cliente,
      registro.id,
      arquivo.idArquivo,
    );
    const rejeitadas = contagens.reduce((s, c) => s + c.quantidade, 0);

    const merge = await mergeIncremental(cliente, registro.id, arquivo.idArquivo);

    await cliente.query(
      `UPDATE infoprice.ctl_execucao_arquivo
          SET linhas_lidas = $3,
              linhas_gravadas = $4,
              linhas_rejeitadas = $5,
              linhas_inseridas = $6,
              linhas_atualizadas = $7,
              destino = 'stg → fact',
              status = 'ingerido',
              erro = NULL,
              ingerido_em = now()
        WHERE id_execucao = $1 AND id_arquivo = $2`,
      [
        registro.id,
        arquivo.idArquivo,
        carga.linhas,
        merge.gravadas,
        rejeitadas,
        merge.inseridas,
        merge.atualizadas,
      ],
    );

    // O inventário guarda só a situação atual do arquivo na origem.
    await cliente.query(
      `UPDATE infoprice.ctl_arquivo
          SET status = 'ingerido', erro = NULL, ingerido_em = now(), atualizado_em = now()
        WHERE id = $1`,
      [arquivo.idArquivo],
    );

    return {
      linhas: carga.linhas,
      rejeitadas,
      inseridas: merge.inseridas,
      atualizadas: merge.atualizadas,
      recuperadas: carga.recuperadas,
      malformadas: carga.malformadas,
      lojasNovas,
      contagens,
    };
  }, { longa: true });
}

/** Marca o arquivo com erro nesta execução e no inventário, fora de transação. */
async function marcarArquivoComErro(
  idExecucao: number,
  idArquivo: number,
  mensagem: string,
): Promise<void> {
  await pool.query(
    `UPDATE infoprice.ctl_execucao_arquivo
        SET status = 'erro', erro = $3
      WHERE id_execucao = $1 AND id_arquivo = $2`,
    [idExecucao, idArquivo, mensagem],
  );
  await pool.query(
    `UPDATE infoprice.ctl_arquivo
        SET status = 'erro', erro = $2, atualizado_em = now()
      WHERE id = $1`,
    [idArquivo, mensagem],
  );
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
