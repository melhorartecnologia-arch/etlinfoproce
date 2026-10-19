import fsp from 'node:fs/promises';
import path from 'node:path';
import type { RunDisponivel, RunsResposta } from '@infoprice/shared';
import { config } from '../config.js';
import { consultar } from '../db/pool.js';
import { comOrigem } from '../sftp/index.js';
import { dataLocal } from '../util/tempo.js';

const DATA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * As datas que podem ser processadas: as pastas run= que ainda estão na
 * origem, as que têm cópia local na área temporária (a origem guarda poucos
 * dias; a cópia local, mais) e, para cada uma, a última execução.
 */
export async function listarRuns(): Promise<RunsResposta> {
  const runs = new Map<string, RunDisponivel>();
  const pegar = (runDate: string) => {
    let r = runs.get(runDate);
    if (!r) {
      r = { runDate, naOrigem: false, arquivosOrigem: 0, copiaLocal: false, arquivosLocais: 0, ultimaExecucao: null };
      runs.set(runDate, r);
    }
    return r;
  };

  let erroOrigem: string | null = null;
  try {
    await comOrigem(async (driver) => {
      for (const pasta of await driver.listarPastas()) {
        const r = pegar(pasta.runDate);
        r.naOrigem = true;
        r.arquivosOrigem = (await driver.listarArquivos(pasta.caminho)).length;
      }
    });
  } catch (erro) {
    erroOrigem = erro instanceof Error ? erro.message : String(erro);
  }

  try {
    for (const item of await fsp.readdir(config.coleta.areaTemporaria, { withFileTypes: true })) {
      if (!item.isDirectory() || !DATA.test(item.name)) continue;
      const nomes = await fsp.readdir(path.join(config.coleta.areaTemporaria, item.name));
      const arquivos = nomes.filter((n) => /\.csv(\.gz)?$/.test(n)).length;
      if (arquivos > 0) {
        const r = pegar(item.name);
        r.copiaLocal = true;
        r.arquivosLocais = arquivos;
      }
    }
  } catch {
    // área temporária ainda não criada
  }

  const ultimas = await consultar<{
    runDate: string;
    id: number;
    status: string;
    finalizadoEm: string | null;
    linhasGravadas: number;
    linhasRejeitadas: number;
  }>(
    `SELECT DISTINCT ON (run_date)
            run_date::text      AS "runDate",
            id, status,
            finalizado_em       AS "finalizadoEm",
            linhas_gravadas     AS "linhasGravadas",
            linhas_rejeitadas   AS "linhasRejeitadas"
       FROM infoprice.ctl_execucao
      ORDER BY run_date DESC, id DESC
      LIMIT 120`,
  );
  for (const u of ultimas) {
    const { runDate, ...execucao } = u;
    pegar(runDate).ultimaExecucao = {
      ...execucao,
      linhasGravadas: Number(execucao.linhasGravadas),
      linhasRejeitadas: Number(execucao.linhasRejeitadas),
    };
  }

  return {
    hoje: dataLocal(),
    runs: [...runs.values()].sort((a, b) => b.runDate.localeCompare(a.runDate)),
    erroOrigem,
    retencaoOrigemDias: config.coleta.retencaoOrigemDias,
    retencaoLocalDias: config.coleta.retencaoLocalDias,
  };
}

/** Natureza da carga de um run: já processado, data passada ou o dia. */
export async function tipoDaCarga(
  runDate: string,
): Promise<'incremental' | 'reprocessamento' | 'carga_historica'> {
  const [r] = await consultar<{ existe: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM infoprice.ctl_execucao
        WHERE run_date = $1 AND status IN ('concluida', 'parcial')
     ) AS existe`,
    [runDate],
  );
  if (r?.existe) return 'reprocessamento';
  return runDate < dataLocal() ? 'carga_historica' : 'incremental';
}
