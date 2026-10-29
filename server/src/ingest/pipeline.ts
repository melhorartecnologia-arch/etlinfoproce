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
import { carregarArquivoRapido, type ResultadoCargaRapida } from './carga-rapida.js';
import {
  COLUNAS_OBRIGATORIAS,
  lerCabecalho,
  validarCabecalho,
} from './leitor-csv.js';
import { RegistroExecucao } from './registro-execucao.js';
import { AcompanhamentoArquivo } from './acompanhamento.js';
import {
  ExecucaoCancelada,
  manterBatimento,
  registrarExecucao,
  type ControleCancelamento,
} from './cancelamento.js';
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
  status: 'concluida' | 'parcial' | 'falha' | 'cancelada';
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

/**
 * Roda `tarefas` com no máximo `limite` em paralelo, preservando a ordem.
 *
 * Depois do primeiro erro nenhum item novo começa, e o erro só sobe quando
 * os que já estavam em curso terminarem: numa parada, cada transação aberta
 * é revertida antes de a execução ser fechada como cancelada.
 */
async function emParalelo<T, R>(
  itens: T[],
  limite: number,
  fn: (item: T, indice: number) => Promise<R>,
): Promise<R[]> {
  const resultados = new Array<R>(itens.length);
  let proximo = 0;
  let falhou = false;

  const trabalhador = async () => {
    while (!falhou) {
      const i = proximo++;
      if (i >= itens.length) return;
      try {
        resultados[i] = await fn(itens[i]!, i);
      } catch (erro) {
        falhou = true;
        throw erro;
      }
    }
  };

  const fim = await Promise.allSettled(
    Array.from({ length: Math.max(1, Math.min(limite, itens.length)) }, trabalhador),
  );
  const erro = fim.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (erro) throw erro.reason;
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
  // A parada pode vir da tela, do Ctrl+C ou do desligamento do servidor; o
  // batimento diz ao banco que esta execução tem um processo vivo por trás.
  const controle = registrarExecucao(registro.id);
  const pararBatimento = manterBatimento(registro.id);

  try {
    const resultado = await comOrigem(async (d) => {
      driver = d;
      return await rodarEtapas(registro, d, opcoes, controle);
    });

    const duracao = Date.now() - inicio;
    await registro.info(
      `execução concluída em ${duracaoBR(duracao)} · ${numeroBR(resultado.linhasGravadas)} linhas efetivadas`,
    );

    await avaliarPosExecucao(registro.id, runDate);
    await notificarResultado(registro.id);

    return { ...resultado, idExecucao: registro.id };
  } catch (erro) {
    // Parada pedida: não é falha, não abre incidente nem dispara retentativa.
    // Uma consulta interrompida no banco chega como erro do PostgreSQL; o
    // sinal abortado é o que diz que foi parada, e não defeito.
    const cancelada = erro instanceof ExecucaoCancelada || controle.sinal.aborted;
    const msg = erro instanceof ExecucaoCancelada
      ? erro.motivo
      : erro instanceof Error ? erro.message : String(erro);

    if (cancelada) {
      const motivo = erro instanceof ExecucaoCancelada ? erro.motivo : 'parada pedida';
      await registro.warn(
        `execução cancelada · ${motivo} · arquivos já gravados permanecem; o arquivo em curso foi revertido`,
      );
      await registro.encerrarEtapasAbertas('cancelada');
      await registro.finalizar('cancelada', `cancelada · ${motivo}`);
    } else {
      await registro.erro(`execução interrompida: ${msg}`);
      await registro.finalizar('falha', msg);
      await avaliarPosExecucao(registro.id, runDate);
      await notificarResultado(registro.id);
    }

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
      status: cancelada ? 'cancelada' : 'falha',
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
    pararBatimento();
    controle.liberar();
  }
}

async function rodarEtapas(
  registro: RegistroExecucao,
  driver: DriverOrigem,
  opcoes: OpcoesColeta,
  controle: ControleCancelamento,
): Promise<Omit<ResultadoColeta, 'idExecucao'>> {
  // Pontos seguros de parada: antes de cada etapa e de cada arquivo, e a cada
  // lote lido durante a carga.
  const verificar = controle.verificar;
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
  // A origem guarda cada pasta por poucos dias. Uma data que já saiu dela
  // ainda pode ser processada a partir das cópias locais da área temporária,
  // que ficam por RETENCAO_LOCAL_DIAS.
  let usandoCopiaLocal = false;
  const destinoDir = path.join(config.coleta.areaTemporaria, runDate);
  await verificar();
  const remotos = await registro.etapa('Listagem do diretório', async () => {
    const pastas = await driver.listarPastas();
    const pasta = pastas.find((p) => p.runDate === runDate);

    let arquivos: ArquivoRemoto[];
    if (pasta) {
      arquivos = await driver.listarArquivos(pasta.caminho);
    } else {
      arquivos = await listarCopiasLocais(destinoDir);
      if (arquivos.length === 0) {
        throw new Error(
          `pasta ${pastaNome} não encontrada em ${config.sftp.diretorioBase} ` +
            `nem cópia local em ${destinoDir}`,
        );
      }
      usandoCopiaLocal = true;
      await registro.warn(
        `pasta ${pastaNome} não está mais na origem · usando as ${arquivos.length} cópias locais de ${destinoDir}`,
      );
    }
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
      `listagem ${usandoCopiaLocal ? destinoDir : `${config.sftp.diretorioBase}/${pastaNome}`} → ` +
        `${arquivos.length} objetos, ${bytesBR(bytes)}`,
    );

    await compararComMedia(registro, runDate, arquivos.length);
    await registrarInventario(registro.id, pastaNome, runDate, arquivos);

    return {
      resultado: arquivos,
      detalhe:
        `${pastaNome} · ${arquivos.length} arquivos · ${bytesBR(bytes)}` +
        (usandoCopiaLocal ? ' · cópia local' : ''),
    };
  });

  await registro.atualizar({ arquivos_vistos: remotos.length });

  // ── 3 · Download para área temporária ─────────────────────────────────────
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
          await verificar();
          const caminhoLocal = path.join(destinoDir, arquivo.nome);
          // Da cópia local não há o que baixar: ela já está no destino.
          const bytes = usandoCopiaLocal
            ? (await fsp.stat(caminhoLocal)).size
            : await driver.baixar(arquivo.caminho, caminhoLocal);
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
  await verificar();
  await registro.etapa('Verificação de integridade', async () => {
    // Em paralelo, como o download. O hash do conteúdo descompactado é
    // opcional (HASH_DESCOMPACTADO): ele obriga a descompactar a pasta
    // inteira só para conferir.
    await emParalelo(baixados, config.coleta.paralelismo, async (arquivo) => {
      await verificar();
      arquivo.sha256 = await hashArquivo(arquivo.caminhoLocal);
      const descompactado = config.coleta.hashDescompactado
        ? await hashDescompactado(arquivo.caminhoLocal)
        : null;
      await pool.query(
        `UPDATE infoprice.ctl_arquivo
            SET sha256 = $2, sha256_descompactado = $3, atualizado_em = now()
          WHERE id = $1`,
        [arquivo.idArquivo, arquivo.sha256, descompactado],
      );
    });
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
      await verificar();
      let recusa: { motivo: string; amostra: string } | null;
      try {
        const info = await lerCabecalho(arquivo.caminhoLocal);
        colunas = Math.max(colunas, info.colunas.length);
        recusa = validarCabecalho(info);
        // Guardado para a tela de rejeições mostrar cada valor ao lado do
        // nome da coluna.
        await pool.query(
          `UPDATE infoprice.ctl_arquivo SET cabecalho = $2, delimitador = $3 WHERE id = $1`,
          [arquivo.idArquivo, info.semCabecalho ? null : info.primeiraLinha, info.delimitador],
        );
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

  // ── 6 a 8 · um arquivo por vez, direto na tabela final ────────────────────
  // Cada arquivo é lido pelo COPY nativo e gravado no fato numa transação
  // própria, efetivada antes do próximo começar. O que já foi gravado fica
  // gravado: uma falha no arquivo 30 não desfaz os 29 anteriores — reverte só
  // o arquivo 30, que a varredura tenta de novo. Sem regras de qualidade: a
  // linha entra como veio, desde que tenha o que a tabela exige.
  await registro.iniciarEtapa('Carga em staging');
  await registro.ignorarEtapa('Regras de qualidade', 'desligadas · carga direta');
  await registro.iniciarEtapa('Merge incremental');

  const totais = {
    arquivosIngeridos: 0,
    linhas: 0,
    naoGravadas: 0,
    inseridas: 0,
    atualizadas: 0,
    comErro: 0,
  };

  // Vários arquivos ao mesmo tempo, cada um na sua transação e na sua conexão:
  // a gravação de um arquivo usa um núcleo do banco, e o paralelismo soma os
  // demais. Dois arquivos com a mesma chave podem se esperar ou travar um ao
  // outro (deadlock); o que perder fica para o fim e é regravado sozinho.
  const paralelo = Math.max(1, Math.trunc(config.coleta.paralelismoGravacao));
  // Cada parte ocupa uma conexão do pool até o fim; o resto do pool fica para
  // o log, o progresso e as telas. Sem esta conta, as partes esperariam por
  // conexão e a gravação ficaria mais lenta, não mais rápida.
  const folga = Math.max(1, config.banco.maxConexoes - 3);
  let partes = Math.max(1, Math.trunc(config.coleta.partesPorArquivo));
  if (paralelo * partes > folga) {
    const pedidas = partes;
    partes = Math.max(1, Math.floor(folga / paralelo));
    await registro.warn(
      `${paralelo} arquivo(s) × ${pedidas} partes não cabem no pool de ${config.banco.maxConexoes} ` +
        `conexões (PGPOOL_MAX) · gravando em ${partes} parte(s) por arquivo`,
    );
  }
  await registro.info(
    `gravação · ${partes} parte(s) por arquivo` +
      (paralelo > 1 ? ` · ${paralelo} arquivos por vez` : ''),
  );

  // Criar partição trava a tabela final inteira até o fim da transação que a
  // criou. Feito dentro da gravação de um arquivo, pararia os demais arquivos
  // em paralelo: por isso as partições do período usual são criadas aqui,
  // antes, cada uma na sua transação curta. Uma data fora dele ainda cria a
  // partição na gravação do arquivo.
  const criadas = await garantirParticoesDoPeriodo(runDate);
  if (criadas > 0) await registro.info(`${criadas} partições mensais criadas em fact_preco_coletado`);

  const gravarArquivo = async (
    arquivo: ArquivoLocal,
    i: number,
    podeAdiar: boolean,
  ): Promise<'ok' | 'adiado' | 'erro'> => {
    const t0 = Date.now();
    const posicao = `[${i + 1}/${aptos.length}]`;
    await verificar();
    const acompanhamento = new AcompanhamentoArquivo(registro, {
      posicao: i + 1,
      total: aptos.length,
      idArquivo: arquivo.idArquivo,
      nome: arquivo.nome,
    });
    let resultado: 'ok' | 'adiado' | 'erro' = 'ok';
    try {
      await acompanhamento.iniciar();
      const r = await processarArquivo(registro, arquivo, controle, acompanhamento, partes);
      await acompanhamento.encerrar('efetivado');

      totais.arquivosIngeridos += 1;
      totais.linhas += r.linhas;
      totais.naoGravadas += r.naoGravadas;
      totais.inseridas += r.inseridas;
      totais.atualizadas += r.atualizadas;

      const segundos = Math.max(0.001, (Date.now() - t0) / 1000);
      await registro.info(
        `${posicao} ${arquivo.nome} gravado em ${duracaoBR(Date.now() - t0)} · ` +
          `${numeroBR(r.linhas)} lidas · ${numeroBR(r.inseridas)} inseridas · ` +
          `${numeroBR(r.atualizadas)} atualizadas · ${numeroBR(r.naoGravadas)} não gravadas · ` +
          `${numeroBR(Math.round(r.linhas / segundos))} linhas/s · tempos: ${acompanhamento.tempos()}`,
      );
      if (r.modo === 'tolerante') {
        await registro.warn(
          `${arquivo.nome}: lido pelo leitor tolerante (mais lento)` +
            (r.recuperadas > 0 ? ` · ${numeroBR(r.recuperadas)} linhas com aspas fora do padrão` : '') +
            (r.malformadas > 0 ? ` · ${numeroBR(r.malformadas)} linhas ilegíveis ficaram de fora` : ''),
        );
      }
    } catch (erro) {
      const tempos = acompanhamento.tempos();
      await acompanhamento.encerrar('revertido');
      // Parada pedida no meio do arquivo: ele já foi revertido; a execução
      // inteira para aqui, sem marcar o arquivo como defeituoso.
      if (erro instanceof ExecucaoCancelada || controle.sinal.aborted) {
        await verificar();
        throw erro;
      }
      const msg = erro instanceof Error ? erro.message : String(erro);
      const codigo = (erro as { code?: string } | null)?.code;
      // Deadlock, lock esperado demais ou partição criada ao mesmo tempo por
      // outro arquivo: conflitos da gravação em paralelo, que somem sozinho.
      if (podeAdiar && ['40P01', '55P03', '42P07', '23505'].includes(codigo ?? '')) {
        resultado = 'adiado';
        await registro.warn(
          `${posicao} ${arquivo.nome} revertido por conflito de lock com outra gravação (${msg}) · ` +
            'regravado sozinho no fim',
        );
      } else {
        resultado = 'erro';
        totais.comErro += 1;
        await registro.erro(
          `${posicao} ${arquivo.nome} revertido: ${explicarErroBanco(erro, msg)} · ` +
            `tempos: ${tempos} · os demais arquivos seguem`,
        );
        await marcarArquivoComErro(registro.id, arquivo.idArquivo, msg);
      }
    }

    // O painel acompanha o avanço arquivo a arquivo.
    await registro.atualizar({
      arquivos_ingeridos: totais.arquivosIngeridos,
      linhas_staging: totais.linhas,
      linhas_gravadas: totais.inseridas + totais.atualizadas,
      linhas_inseridas: totais.inseridas,
      linhas_atualizadas: totais.atualizadas,
      linhas_rejeitadas: 0,
    });
    return resultado;
  };

  const adiados: [ArquivoLocal, number][] = [];
  await emParalelo(aptos, paralelo, async (arquivo, i) => {
    if ((await gravarArquivo(arquivo, i, paralelo > 1)) === 'adiado') adiados.push([arquivo, i]);
  });
  for (const [arquivo, i] of adiados) {
    await gravarArquivo(arquivo, i, false);
  }

  const gravadas = totais.inseridas + totais.atualizadas;
  const sufixoErro =
    totais.comErro > 0 ? ` · ${totais.comErro} arquivo(s) com erro` : '';

  if (totais.arquivosIngeridos === 0) {
    const detalhe = `nenhum dos ${aptos.length} arquivos pôde ser gravado`;
    await registro.falharEtapa('Carga em staging', detalhe);
    await registro.falharEtapa('Merge incremental', detalhe);
    throw new Error(detalhe);
  }

  if (totais.naoGravadas > 0) {
    await registro.info(
      `${numeroBR(totais.naoGravadas)} linhas lidas e não gravadas: iguais às já gravadas, ` +
        'repetidas no arquivo (vale a última) ou sem gtin, loja, data ou preço legível',
    );
  }

  await registro.concluirEtapa(
    'Carga em staging',
    `COPY nativo → tabela temporária · ${numeroBR(totais.linhas)} linhas${sufixoErro}`,
  );
  await registro.concluirEtapa(
    'Merge incremental',
    `UPSERT → fact_preco_coletado · ${numeroBR(gravadas)} · ` +
      `${totais.arquivosIngeridos} de ${aptos.length} arquivos efetivados`,
  );

  // ── 9 · Auditoria e watermark ─────────────────────────────────────────────
  await verificar();
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

  return {
    status,
    arquivosVistos: remotos.length,
    arquivosIngeridos: totais.arquivosIngeridos,
    linhasStaging: totais.linhas,
    linhasGravadas: gravadas,
    linhasInseridas: totais.inseridas,
    linhasAtualizadas: totais.atualizadas,
    linhasRejeitadas: 0,
  };
}

/**
 * Leva um arquivo direto à tabela final: COPY nativo para a tabela de carga,
 * o UPSERT no fato em partes paralelas e, por fim, a trilha do arquivo.
 */
async function processarArquivo(
  registro: RegistroExecucao,
  arquivo: ArquivoLocal,
  controle: ControleCancelamento,
  acompanhamento: AcompanhamentoArquivo,
  partes: number,
): Promise<ResultadoCargaRapida> {
  await acompanhamento.fase('COPY → tabela de carga');

  const carga = await carregarArquivoRapido({
    idExecucao: registro.id,
    idArquivo: arquivo.idArquivo,
    caminhoLocal: arquivo.caminhoLocal,
    fonte: config.coleta.fonte,
    partes,
    verificar: controle.verificar,
    // Com o backend registrado, uma parada interrompe a consulta em curso no
    // próprio PostgreSQL, em vez de esperar a gravação terminar.
    comPid: controle.comPid,
    aoAbrir: (cliente, pid, rotulo) => acompanhamento.vincular(cliente, pid, rotulo),
    aoFechar: (pid) => acompanhamento.desvincular(pid),
    aoProgresso: (linhas) => acompanhamento.linhas(linhas),
    aoPasso: (passo, detalhe) =>
      passo === 'partições'
        ? acompanhamento.fase('partições')
        : acompanhamento.fase('gravação → fact_preco_coletado', detalhe),
    aoReler: async (motivo) => {
      await registro.warn(
        `${arquivo.nome}: o COPY nativo recusou o arquivo (${motivo.slice(0, 300)}) · ` +
          'relendo com o leitor tolerante',
      );
      await acompanhamento.detalhe('leitor tolerante');
    },
  });

  // O cabeçalho já foi conferido; esta checagem só pega um arquivo que
  // mudou de layout entre a validação e a carga.
  const faltando = COLUNAS_OBRIGATORIAS.filter((c) => !carga.cabecalho.includes(c));
  if (faltando.length > 0) {
    throw new Error(`schema divergente · sem ${faltando.join(', ')}`);
  }

  const gravadas = carga.inseridas + carga.atualizadas;
  await emTransacao(async (cliente) => {
    await cliente.query(
      `UPDATE infoprice.ctl_execucao_arquivo
          SET linhas_lidas = $3,
              linhas_gravadas = $4,
              linhas_rejeitadas = 0,
              linhas_inseridas = $5,
              linhas_atualizadas = $6,
              destino = 'copy → fact',
              status = 'ingerido',
              erro = NULL,
              ingerido_em = now()
        WHERE id_execucao = $1 AND id_arquivo = $2`,
      [registro.id, arquivo.idArquivo, carga.linhas, gravadas, carga.inseridas, carga.atualizadas],
    );
    // O inventário guarda só a situação atual do arquivo na origem.
    await cliente.query(
      `UPDATE infoprice.ctl_arquivo
          SET status = 'ingerido', erro = NULL, ingerido_em = now(), atualizado_em = now()
        WHERE id = $1`,
      [arquivo.idArquivo],
    );
  });
  return carga;
}

/**
 * O erro do PostgreSQL em linguagem de operação. lock_timeout e
 * statement_timeout chegam como "canceling statement due to …", que não diz
 * o que fazer.
 */
function explicarErroBanco(erro: unknown, msg: string): string {
  const codigo = (erro as { code?: string } | null)?.code;
  if (codigo === '55P03') {
    return (
      `${msg} · a gravação esperou ${duracaoBR(config.banco.timeoutLockMs)} por um lock ` +
      'preso por outra sessão (veja no log quem o segurava) · PG_TIMEOUT_LOCK_MS'
    );
  }
  if (codigo === '57014' && /statement timeout/i.test(msg)) {
    return (
      `${msg} · uma consulta da gravação passou de ${duracaoBR(config.banco.timeoutIngestaoMs)} · ` +
      'PG_TIMEOUT_INGESTAO_MS'
    );
  }
  if (codigo === '40P01') return `${msg} · deadlock com outra sessão`;
  return msg;
}

/** Meses de partição criados antes da gravação: os últimos dois anos e o próximo mês. */
const MESES_ANTES = 24;

/**
 * Garante as partições mensais de MESES_ANTES antes do run até o mês seguinte
 * a ele. Devolve quantas não existiam.
 */
async function garantirParticoesDoPeriodo(runDate: string): Promise<number> {
  const { rows } = await pool.query<{ criadas: number }>(
    `WITH meses AS (
       SELECT generate_series(
                date_trunc('month', $1::date) - make_interval(months => $2),
                date_trunc('month', $1::date) + INTERVAL '1 month',
                INTERVAL '1 month'
              )::date AS mes
     )
     SELECT count(*)::int AS criadas
       FROM meses
      WHERE NOT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'infoprice'
           AND c.relname = 'fact_preco_coletado_' || to_char(meses.mes, 'YYYY_MM')
      )`,
    [runDate, MESES_ANTES],
  );
  const criadas = rows[0]?.criadas ?? 0;
  if (criadas === 0) return 0;
  for (let i = MESES_ANTES; i >= -1; i -= 1) {
    await pool.query(
      `SELECT infoprice.garantir_particao((date_trunc('month', $1::date) - make_interval(months => $2))::date)`,
      [runDate, i],
    );
  }
  return criadas;
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

/** Os .csv/.csv.gz já baixados para a pasta do run na área temporária. */
async function listarCopiasLocais(dir: string): Promise<ArquivoRemoto[]> {
  let nomes: string[];
  try {
    nomes = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const arquivos: ArquivoRemoto[] = [];
  for (const nome of nomes.filter((n) => /\.csv(\.gz)?$/.test(n)).sort()) {
    const caminho = path.join(dir, nome);
    const info = await fsp.stat(caminho);
    if (info.isFile()) {
      arquivos.push({ nome, caminho, tamanhoBytes: info.size, modificadoEm: info.mtime });
    }
  }
  return arquivos;
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
