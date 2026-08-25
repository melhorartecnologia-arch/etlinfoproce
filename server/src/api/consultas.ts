import type {
  Arquivo,
  Etapa,
  EtapaFluxo,
  EventoLog,
  Execucao,
  Incidente,
  LinhagemArquivo,
  PastaInventario,
  Preco,
  RegraAlerta,
  Rejeicao,
  StatusExecucao,
} from '@infoprice/shared';
import { config } from '../config.js';
import { consultar, consultarUm } from '../db/pool.js';
import { diferencaDias, dataLocal } from '../util/tempo.js';

/** Colunas de ctl_execucao já com os nomes que a API expõe. */
const CAMPOS_EXECUCAO = `
  e.id,
  e.run_date                                      AS "runDate",
  e.tipo,
  e.gatilho,
  e.assinatura,
  e.iniciado_em                                   AS "iniciadoEm",
  e.finalizado_em                                 AS "finalizadoEm",
  (EXTRACT(EPOCH FROM (COALESCE(e.finalizado_em, now()) - e.iniciado_em)) * 1000)::bigint AS "duracaoMs",
  e.status,
  e.arquivos_vistos                               AS "arquivosVistos",
  e.arquivos_ingeridos                            AS "arquivosIngeridos",
  e.bytes_baixados                                AS "bytesBaixados",
  e.linhas_staging                                AS "linhasStaging",
  e.linhas_gravadas                               AS "linhasGravadas",
  e.linhas_inseridas                              AS "linhasInseridas",
  e.linhas_atualizadas                            AS "linhasAtualizadas",
  e.linhas_rejeitadas                             AS "linhasRejeitadas",
  e.watermark_anterior                            AS "watermarkAnterior",
  e.watermark_novo                                AS "watermarkNovo",
  e.erro
`;

export async function buscarExecucao(id: number): Promise<Execucao | null> {
  return consultarUm<Execucao>(
    `SELECT ${CAMPOS_EXECUCAO} FROM infoprice.ctl_execucao e WHERE e.id = $1`,
    [id],
  );
}

export async function historicoExecucoes(limite = 20): Promise<Execucao[]> {
  return consultar<Execucao>(
    `SELECT ${CAMPOS_EXECUCAO}
       FROM infoprice.ctl_execucao e
      ORDER BY e.iniciado_em DESC
      LIMIT $1`,
    [limite],
  );
}

/** A execução mais recente do run informado. */
export async function execucaoDoRun(runDate: string): Promise<Execucao | null> {
  return consultarUm<Execucao>(
    `SELECT ${CAMPOS_EXECUCAO}
       FROM infoprice.ctl_execucao e
      WHERE e.run_date = $1
      ORDER BY e.id DESC
      LIMIT 1`,
    [runDate],
  );
}

export async function etapasDaExecucao(id: number): Promise<Etapa[]> {
  return consultar<Etapa>(
    `SELECT ordem, nome, detalhe, status,
            iniciado_em   AS "iniciadoEm",
            finalizado_em AS "finalizadoEm",
            duracao_ms    AS "duracaoMs"
       FROM infoprice.ctl_execucao_etapa
      WHERE id_execucao = $1
      ORDER BY ordem`,
    [id],
  );
}

export async function logDaExecucao(
  id: number,
  limite = 200,
): Promise<{ eventos: EventoLog[]; total: number }> {
  const eventos = await consultar<EventoLog>(
    `SELECT id, ts, nivel, mensagem
       FROM infoprice.ctl_execucao_log
      WHERE id_execucao = $1
      ORDER BY id
      LIMIT $2`,
    [id, limite],
  );

  const total = await consultarUm<{ total: number }>(
    'SELECT count(*)::bigint AS total FROM infoprice.ctl_execucao_log WHERE id_execucao = $1',
    [id],
  );

  return { eventos, total: total?.total ?? eventos.length };
}

/**
 * O arquivo visto do ângulo de uma execução: identidade e hash vêm do
 * inventário, contagens e horários da participação naquela execução.
 */
const CAMPOS_ARQUIVO_EXEC = `
  a.id,
  ea.id_execucao                   AS "idExecucao",
  a.pasta,
  a.nome,
  a.caminho_remoto                 AS "caminhoRemoto",
  a.tamanho_bytes                  AS "tamanhoBytes",
  a.sha256,
  a.sha256_descompactado           AS "sha256Descompactado",
  a.visto_em                       AS "vistoEm",
  ea.baixado_em                    AS "baixadoEm",
  ea.ingerido_em                   AS "ingeridoEm",
  ea.linhas_lidas                  AS "linhasLidas",
  ea.linhas_gravadas               AS "linhasGravadas",
  ea.linhas_rejeitadas             AS "linhasRejeitadas",
  ea.linhas_inseridas              AS "linhasInseridas",
  ea.linhas_atualizadas            AS "linhasAtualizadas",
  ea.destino,
  ea.status,
  a.expira_em                      AS "expiraEm",
  (a.caminho_local IS NOT NULL)    AS "temCopiaLocal"
`;

export async function arquivosDaExecucao(id: number): Promise<Arquivo[]> {
  return consultar<Arquivo>(
    `SELECT ${CAMPOS_ARQUIVO_EXEC}
       FROM infoprice.ctl_execucao_arquivo ea
       JOIN infoprice.ctl_arquivo a ON a.id = ea.id_arquivo
      WHERE ea.id_execucao = $1
      ORDER BY a.nome`,
    [id],
  );
}

/** O arquivo no inventário, sem recorte de execução — usado pelo download. */
export async function buscarArquivo(id: number): Promise<
  (Arquivo & { caminhoLocal: string | null; runDate: string }) | null
> {
  return consultarUm(
    `SELECT a.id,
            a.id_execucao                 AS "idExecucao",
            a.pasta,
            a.nome,
            a.caminho_remoto              AS "caminhoRemoto",
            a.tamanho_bytes               AS "tamanhoBytes",
            a.sha256,
            a.sha256_descompactado        AS "sha256Descompactado",
            a.visto_em                    AS "vistoEm",
            a.baixado_em                  AS "baixadoEm",
            a.ingerido_em                 AS "ingeridoEm",
            COALESCE(ea.linhas_lidas, 0)       AS "linhasLidas",
            COALESCE(ea.linhas_gravadas, 0)    AS "linhasGravadas",
            COALESCE(ea.linhas_rejeitadas, 0)  AS "linhasRejeitadas",
            COALESCE(ea.linhas_inseridas, 0)   AS "linhasInseridas",
            COALESCE(ea.linhas_atualizadas, 0) AS "linhasAtualizadas",
            ea.destino,
            a.status,
            a.expira_em                   AS "expiraEm",
            (a.caminho_local IS NOT NULL) AS "temCopiaLocal",
            a.caminho_local               AS "caminhoLocal",
            a.run_date                    AS "runDate"
       FROM infoprice.ctl_arquivo a
       LEFT JOIN infoprice.ctl_execucao_arquivo ea
              ON ea.id_arquivo = a.id AND ea.id_execucao = a.id_execucao
      WHERE a.id = $1`,
    [id],
  );
}

/** Inventário do diretório SFTP, agrupado por pasta run=. */
export async function inventario(): Promise<PastaInventario[]> {
  const linhas = await consultar<{
    pasta: string;
    runDate: string;
    arquivos: number;
    bytes: number;
    vistoEm: string | null;
    ingeridoEm: string | null;
    expiraEm: string | null;
    ingeridos: number;
    pendentes: number;
    parciais: number;
    idExecucao: number | null;
  }>(
    `SELECT a.pasta,
            a.run_date                                        AS "runDate",
            count(*)::bigint                                  AS arquivos,
            sum(a.tamanho_bytes)::bigint                      AS bytes,
            min(a.visto_em)                                   AS "vistoEm",
            max(a.ingerido_em)                                AS "ingeridoEm",
            max(a.expira_em)::text                            AS "expiraEm",
            count(*) FILTER (WHERE a.status = 'ingerido')::bigint AS ingeridos,
            count(*) FILTER (WHERE a.status IN ('visto', 'baixado', 'erro'))::bigint AS pendentes,
            count(*) FILTER (WHERE a.status = 'rejeitado')::bigint AS parciais,
            max(a.id_execucao)                                AS "idExecucao"
       FROM infoprice.ctl_arquivo a
      GROUP BY a.pasta, a.run_date
      ORDER BY a.run_date DESC`,
  );

  const hoje = dataLocal();

  return linhas.map((l) => {
    const expiraEmDias = l.expiraEm ? diferencaDias(hoje, l.expiraEm) : null;
    const expirado = expiraEmDias !== null && expiraEmDias < 0;

    let situacao: string;
    let status: PastaInventario['status'];

    if (expirado && l.ingeridos > 0) {
      situacao = 'Arquivado localmente';
      status = 'arquivado';
    } else if (l.pendentes > 0 && l.ingeridos > 0) {
      situacao = `Parcial · ${l.pendentes} arquivo${l.pendentes > 1 ? 's' : ''} pendente${l.pendentes > 1 ? 's' : ''}`;
      status = 'baixado';
    } else if (l.ingeridos === Number(l.arquivos)) {
      situacao = 'Ingerido';
      status = 'ingerido';
    } else if (l.pendentes > 0) {
      situacao = 'Aguardando ingestão';
      status = 'visto';
    } else {
      situacao = 'Sem ingestão';
      status = 'erro';
    }

    return {
      pasta: l.pasta,
      runDate: l.runDate,
      arquivos: l.arquivos,
      bytes: l.bytes,
      vistoEm: l.vistoEm,
      ingeridoEm: l.ingeridoEm,
      expiraEm: l.expiraEm,
      expiraEmDias,
      situacao,
      status,
      idExecucao: l.idExecucao,
      pendentes: l.pendentes,
    };
  });
}

/** Linhagem por arquivo do run informado. */
export async function linhagemPorArquivo(
  idExecucao: number,
): Promise<LinhagemArquivo[]> {
  return consultar<LinhagemArquivo>(
    `SELECT a.id                                    AS "idArquivo",
            a.nome                                  AS arquivo,
            ea.linhas_lidas                         AS "noArquivo",
            ea.linhas_lidas                         AS staging,
            ea.linhas_rejeitadas                    AS rejeitadas,
            ea.linhas_inseridas                     AS inseridas,
            ea.linhas_atualizadas                   AS atualizadas,
            'preco_' || to_char(a.run_date, 'YYYY_MM') AS particao,
            ea.id_execucao                          AS "idExecucao"
       FROM infoprice.ctl_execucao_arquivo ea
       JOIN infoprice.ctl_arquivo a ON a.id = ea.id_arquivo
      WHERE ea.id_execucao = $1
      ORDER BY a.nome`,
    [idExecucao],
  );
}

/** O fluxo de quatro etapas: origem → staging → regras → fato. */
export async function fluxoLinhagem(
  execucao: Execucao,
): Promise<EtapaFluxo[]> {
  const arquivos = await consultarUm<{ total: number; bytes: number }>(
    `SELECT count(*)::bigint AS total,
            COALESCE(sum(a.tamanho_bytes), 0)::bigint AS bytes
       FROM infoprice.ctl_execucao_arquivo ea
       JOIN infoprice.ctl_arquivo a ON a.id = ea.id_arquivo
      WHERE ea.id_execucao = $1`,
    [execucao.id],
  );

  const pct =
    execucao.linhasStaging > 0
      ? (execucao.linhasRejeitadas / execucao.linhasStaging) * 100
      : 0;

  return [
    {
      etapa: '1 · origem',
      objeto: `${config.coleta.fonte}/run=${execucao.runDate}`,
      quantidade: execucao.linhasStaging,
      nota: `${arquivos?.total ?? 0} arquivos csv.gz · sha-256 conferido antes da leitura`,
      tom: 'neutro',
    },
    {
      etapa: '2 · staging',
      objeto: 'stg_isa_infopanel_preco',
      quantidade: execucao.linhasStaging,
      nota: 'espelho do arquivo, apagado e recarregado por run',
      tom: 'neutro',
    },
    {
      etapa: '3 · regras',
      objeto: 'ctl_rejeicao',
      quantidade: execucao.linhasRejeitadas,
      nota: `${pct.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% retidas com o payload original`,
      tom: 'atencao',
    },
    {
      etapa: '4 · fato',
      objeto: 'fact_preco_coletado',
      quantidade: execucao.linhasGravadas,
      nota:
        `${execucao.linhasInseridas.toLocaleString('pt-BR')} inseridas · ` +
        `${execucao.linhasAtualizadas.toLocaleString('pt-BR')} atualizadas`,
      tom: 'ok',
    },
  ];
}

/** Caminho inverso: de uma linha do fato de volta até a linha do arquivo. */
export async function caminhoInverso(
  idOuChave: string,
): Promise<{ chave: string; valor: string }[] | null> {
  const linha = await consultarUm<{
    id: string;
    gtin: string;
    id_loja: string;
    rede: string | null;
    preco: string;
    tipo_preco: string;
    data_coleta: string;
    id_execucao: number;
    run_date: string;
    numero_linha: number;
    arquivo: string;
    sha256: string | null;
    baixado_em: string | null;
    ingerido_em: string | null;
    atualizado_em: string;
    criado_em: string;
  }>(
    `SELECT f.id::text, f.gtin, f.id_loja, f.rede, f.preco::text, f.tipo_preco,
            f.data_coleta::text, f.id_execucao, e.run_date::text, f.numero_linha,
            a.nome AS arquivo, a.sha256, a.baixado_em, a.ingerido_em,
            f.atualizado_em, f.criado_em
       FROM infoprice.fact_preco_coletado f
       JOIN infoprice.ctl_execucao e ON e.id = f.id_execucao
       LEFT JOIN infoprice.ctl_arquivo a ON a.id = f.id_arquivo
      WHERE f.id::text = $1
      LIMIT 1`,
    [idOuChave],
  );

  if (!linha) return null;

  const dataHora = (v: string | null) =>
    v
      ? new Date(v).toLocaleString('pt-BR', {
          timeZone: config.agendamento.timezone,
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      : '—';

  const foiAtualizacao = linha.criado_em !== linha.atualizado_em;

  return [
    { chave: 'Linha no fato', valor: linha.id },
    { chave: 'GTIN', valor: linha.gtin },
    {
      chave: 'Loja',
      valor: linha.rede ? `${linha.id_loja} · rede ${linha.rede}` : linha.id_loja,
    },
    {
      chave: 'Preço gravado',
      valor: `${Number(linha.preco).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
      })} · ${linha.tipo_preco.toLowerCase()}`,
    },
    { chave: 'Data da coleta', valor: linha.data_coleta },
    {
      chave: 'Execução',
      valor: `#${linha.id_execucao} · run=${linha.run_date}`,
    },
    { chave: 'Arquivo de origem', valor: linha.arquivo ?? '—' },
    { chave: 'Linha no arquivo', valor: linha.numero_linha.toLocaleString('pt-BR') },
    {
      chave: 'sha-256 do arquivo',
      valor: linha.sha256
        ? `${linha.sha256.slice(0, 4)}…${linha.sha256.slice(-4)}`
        : '—',
    },
    { chave: 'Baixado em', valor: dataHora(linha.baixado_em) },
    { chave: 'Carregado em staging', valor: dataHora(linha.ingerido_em) },
    {
      chave: 'Efetivado no fato',
      valor: `${dataHora(linha.atualizado_em)} · ${
        foiAtualizacao ? 'atualização de preço' : 'inserção'
      }`,
    },
  ];
}

export async function motivosRejeicao(
  idExecucao: number,
): Promise<{ nome: string; quantidade: number }[]> {
  return consultar<{ nome: string; quantidade: number }>(
    `SELECT motivo AS nome, count(*)::bigint AS quantidade
       FROM infoprice.ctl_rejeicao
      WHERE id_execucao = $1
      GROUP BY motivo
      ORDER BY quantidade DESC`,
    [idExecucao],
  );
}

export async function rejeicoes(
  idExecucao: number,
  limite = 50,
): Promise<Rejeicao[]> {
  return consultar<Rejeicao>(
    `SELECT id,
            id_execucao  AS "idExecucao",
            arquivo,
            numero_linha AS "numeroLinha",
            motivo,
            payload,
            tratamento,
            criado_em    AS "criadoEm"
       FROM infoprice.ctl_rejeicao
      WHERE id_execucao = $1
      -- Por arquivo e linha, não por ordem de inserção: as regras rodam em
      -- sequência, então ordenar por id mostraria só o primeiro motivo.
      ORDER BY arquivo, numero_linha
      LIMIT $2`,
    [idExecucao, limite],
  );
}

export async function listarIncidentes(): Promise<Incidente[]> {
  return consultar<Incidente>(
    `SELECT i.id,
            i.codigo,
            i.severidade,
            i.titulo,
            i.detalhe,
            i.aberto_em                              AS "abertoEm",
            i.id_execucao                            AS "idExecucao",
            i.run_date                               AS "runDate",
            i.canal,
            i.status,
            i.resolvido_em                           AS "resolvidoEm",
            i.resolvido_por                          AS "resolvidoPor",
            i.resolucao,
            CASE WHEN i.resolvido_em IS NOT NULL
                 THEN (EXTRACT(EPOCH FROM (i.resolvido_em - i.aberto_em)) * 1000)::bigint
            END                                      AS "duracaoMs"
       FROM infoprice.ctl_incidente i
      ORDER BY (i.status = 'aberto') DESC, i.aberto_em DESC
      LIMIT 50`,
  );
}

export async function listarRegras(): Promise<RegraAlerta[]> {
  return consultar<RegraAlerta>(
    `SELECT id, condicao, severidade, canal, destinatario, ativa
       FROM infoprice.ctl_regra_alerta
      ORDER BY ordem, id`,
  );
}

export interface FiltrosPreco {
  data?: string;
  uf?: string;
  busca?: string;
  tipo?: string;
  limite: number;
}

export async function consultarPrecos(
  f: FiltrosPreco,
): Promise<{ linhas: Preco[]; total: number; atualizadoEm: string | null }> {
  const condicoes: string[] = [];
  const valores: unknown[] = [];

  if (f.data) {
    valores.push(f.data);
    condicoes.push(`f.data_coleta = $${valores.length}::date`);
  }
  if (f.uf && f.uf !== 'Todas') {
    valores.push(f.uf);
    condicoes.push(`f.uf = $${valores.length}`);
  }
  if (f.tipo && f.tipo !== 'Todos') {
    valores.push(f.tipo);
    condicoes.push(`f.tipo_preco = $${valores.length}`);
  }
  if (f.busca) {
    valores.push(`%${f.busca}%`);
    condicoes.push(
      `(f.gtin LIKE $${valores.length} OR f.descricao ILIKE $${valores.length})`,
    );
  }

  const onde = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';

  const agregado = await consultarUm<{ total: number; atualizado: string | null }>(
    `SELECT count(*)::bigint AS total, max(f.atualizado_em) AS atualizado
       FROM infoprice.fact_preco_coletado f ${onde}`,
    valores,
  );

  valores.push(f.limite);
  const linhas = await consultar<Preco>(
    `SELECT f.id::text,
            f.gtin,
            f.descricao,
            f.id_loja                AS "idLoja",
            f.rede,
            f.uf,
            f.preco::text,
            f.preco_promocional::text AS "precoPromocional",
            f.tipo_preco             AS "tipoPreco",
            f.data_coleta            AS "dataColeta",
            f.fonte,
            f.id_execucao            AS "idExecucao",
            f.id_arquivo             AS "idArquivo",
            f.numero_linha           AS "numeroLinha",
            COALESCE(a.nome, '—')    AS arquivo,
            f.criado_em              AS "criadoEm",
            f.atualizado_em          AS "atualizadoEm"
       FROM infoprice.fact_preco_coletado f
       LEFT JOIN infoprice.ctl_arquivo a ON a.id = f.id_arquivo
       ${onde}
      ORDER BY f.atualizado_em DESC, f.gtin
      LIMIT $${valores.length}`,
    valores,
  );

  return {
    linhas,
    total: agregado?.total ?? 0,
    atualizadoEm: agregado?.atualizado ?? null,
  };
}

/** UFs presentes no fato, para preencher o filtro da tela de consulta. */
export async function ufsDisponiveis(): Promise<string[]> {
  const linhas = await consultar<{ uf: string }>(
    `SELECT DISTINCT uf FROM infoprice.fact_preco_coletado
      WHERE uf IS NOT NULL ORDER BY uf`,
  );
  return linhas.map((l) => l.uf);
}

/** "Carga incremental" · "Reprocessamento" · "Carga histórica" */
export function rotuloTipo(tipo: string): string {
  switch (tipo) {
    case 'incremental': return 'Carga incremental';
    case 'reprocessamento': return 'Reprocessamento';
    case 'carga_historica': return 'Carga histórica';
    default: return tipo.replace(/_/g, ' ');
  }
}

/**
 * Concorda o particípio com o gênero do tipo: "carga concluída",
 * "reprocessamento concluído".
 */
export function concordancia(tipo: string, status: StatusExecucao): string {
  const masculino = tipo === 'reprocessamento';
  switch (status) {
    case 'concluida': return masculino ? 'concluído' : 'concluída';
    case 'parcial': return masculino ? 'parcial' : 'parcial';
    case 'em_execucao': return 'em execução';
    case 'cancelada': return masculino ? 'cancelado' : 'cancelada';
    default: return rotuloStatus(status).toLowerCase();
  }
}

export function rotuloStatus(status: StatusExecucao): string {
  switch (status) {
    case 'concluida': return 'Concluída';
    case 'em_execucao': return 'Em execução';
    case 'parcial': return 'Parcial';
    case 'falha': return 'Falha';
    case 'cancelada': return 'Cancelada';
    default: return status;
  }
}
