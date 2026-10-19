import { useEffect, useMemo, useState } from 'react';
import type { RunDisponivel, RunsResposta } from '@infoprice/shared';
import { api } from '../api.js';
import { Aviso, Carregando, Pilula } from './base.js';
import { dataBR, numeroBR, rotuloStatus, tomDoStatus } from '../util.js';
import type { StatusExecucao } from '@infoprice/shared';

/**
 * Escolha das datas da coleta manual. Lista o que está na origem, o que tem
 * cópia local (a origem guarda poucos dias; a cópia, mais) e o que já foi
 * processado. As datas marcadas rodam uma por vez, da mais antiga à mais nova.
 */
export function DialogoColeta({
  aoFechar,
  aoColetar,
}: {
  aoFechar: () => void;
  aoColetar: (runs: string[]) => Promise<void>;
}) {
  const [dados, setDados] = useState<RunsResposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    api
      .runs()
      .then((r) => {
        setDados(r);
        // Por padrão, o dia — se ele já chegou e ainda não foi processado.
        const hoje = r.runs.find((x) => x.runDate === r.hoje);
        if (hoje && disponivel(hoje) && !processado(hoje)) setMarcadas(new Set([r.hoje]));
      })
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    const fechar = (e: KeyboardEvent) => e.key === 'Escape' && aoFechar();
    window.addEventListener('keydown', fechar);
    return () => window.removeEventListener('keydown', fechar);
  }, [aoFechar]);

  const runs = dados?.runs ?? [];
  const pendentes = useMemo(
    () => runs.filter((r) => disponivel(r) && !processado(r)).map((r) => r.runDate),
    [runs],
  );

  const alternar = (run: string) => {
    const novo = new Set(marcadas);
    if (novo.has(run)) novo.delete(run);
    else novo.add(run);
    setMarcadas(novo);
  };

  const confirmar = async () => {
    setEnviando(true);
    try {
      await aoColetar([...marcadas].sort());
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="dialogo-fundo" onClick={aoFechar}>
      <div
        className="dialogo"
        role="dialog"
        aria-modal="true"
        aria-label="Coleta manual"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialogo__cabecalho">
          <h2>Coleta manual</h2>
          <p>
            Escolha as datas. Elas rodam uma por vez, da mais antiga para a mais nova; uma
            data já processada é reprocessada sem duplicar nada.
          </p>
        </div>

        {erro && (
          <Aviso tag="erro" tom="erro">
            {erro}
          </Aviso>
        )}
        {!dados && !erro && <Carregando texto="consultando a origem…" />}

        {dados?.erroOrigem && (
          <Aviso tag="origem" tom="atencao">
            A origem não respondeu ({dados.erroOrigem}). Aparecem só as datas com cópia local.
          </Aviso>
        )}

        {dados && (
          <>
            <div className="dialogo__atalhos">
              <button
                className="botao botao--miudo"
                onClick={() => setMarcadas(new Set(pendentes))}
                disabled={pendentes.length === 0}
              >
                Marcar não processadas ({pendentes.length})
              </button>
              <button
                className="botao botao--miudo"
                onClick={() => setMarcadas(new Set())}
                disabled={marcadas.size === 0}
              >
                Desmarcar todas
              </button>
              <span className="suave" style={{ fontSize: 12 }}>
                origem guarda {dados.retencaoOrigemDias} dias · cópia local, {dados.retencaoLocalDias}
              </span>
            </div>

            <div className="dialogo__lista">
              <table className="tabela">
                <thead>
                  <tr>
                    <th />
                    <th>data</th>
                    <th>na origem</th>
                    <th>cópia local</th>
                    <th>última execução</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.length === 0 && (
                    <tr>
                      <td colSpan={5} className="suave">
                        Nenhuma pasta encontrada na origem nem na área temporária.
                      </td>
                    </tr>
                  )}
                  {runs.map((r) => {
                    const pode = disponivel(r);
                    return (
                      <tr
                        key={r.runDate}
                        className={pode ? 'clicavel' : 'desabilitado'}
                        onClick={() => pode && alternar(r.runDate)}
                        title={pode ? undefined : 'Sem arquivos na origem nem cópia local: não há o que processar'}
                      >
                        <td>
                          <input
                            type="checkbox"
                            checked={marcadas.has(r.runDate)}
                            disabled={!pode}
                            onChange={() => alternar(r.runDate)}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </td>
                        <td className="mono-forte">
                          {dataBR(r.runDate)}
                          {r.runDate === dados.hoje && <span className="suave"> · hoje</span>}
                        </td>
                        <td className="mono">{r.naOrigem ? `${r.arquivosOrigem} arquivos` : '—'}</td>
                        <td className="mono">{r.copiaLocal ? `${r.arquivosLocais} arquivos` : '—'}</td>
                        <td>
                          {r.ultimaExecucao ? (
                            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                              <Pilula tom={tomDoStatus(r.ultimaExecucao.status as StatusExecucao)}>
                                {rotuloStatus(r.ultimaExecucao.status as StatusExecucao)}
                              </Pilula>
                              <span className="mono suave" style={{ fontSize: 11.5 }}>
                                #{r.ultimaExecucao.id} · {numeroBR(r.ultimaExecucao.linhasGravadas)} gravadas ·{' '}
                                {numeroBR(r.ultimaExecucao.linhasRejeitadas)} rejeitadas
                              </span>
                            </span>
                          ) : (
                            <span className="suave">nunca processada</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="dialogo__rodape">
          <button className="botao" onClick={aoFechar}>
            Cancelar
          </button>
          <button
            className="botao botao--primario"
            onClick={confirmar}
            disabled={marcadas.size === 0 || enviando}
          >
            {enviando
              ? 'Disparando…'
              : marcadas.size <= 1
                ? 'Processar data'
                : `Processar ${marcadas.size} datas`}
          </button>
        </div>
      </div>
    </div>
  );
}

function disponivel(r: RunDisponivel): boolean {
  return r.naOrigem || r.copiaLocal;
}

function processado(r: RunDisponivel): boolean {
  return r.ultimaExecucao?.status === 'concluida' || r.ultimaExecucao?.status === 'parcial';
}
