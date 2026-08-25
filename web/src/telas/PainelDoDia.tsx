import { useEffect, useState } from 'react';
import type { PainelResposta } from '@infoprice/shared';
import { api } from '../api.js';
import { useRecurso } from '../hooks.js';
import {
  Aviso,
  CaixaErro,
  Carregando,
  Kpi,
  Painel,
  Pilula,
  TituloTela,
  Vazio,
} from '../componentes/base.js';
import {
  classeEtapa,
  corDoStatus,
  duracaoBR,
  duracaoCurta,
  hora,
  horaCurta,
  numeroBR,
  rotuloStatus,
  rotuloTipo,
  tomDoStatus,
} from '../util.js';

export function PainelDoDia({
  run,
  aoAbrirExecucao,
}: {
  run?: string;
  aoAbrirExecucao: (id: number) => void;
}) {
  // Enquanto houver coleta em andamento a tela se atualiza sozinha, para as
  // etapas avançarem sem o operador precisar recarregar.
  const [intervalo, setIntervalo] = useState<number | undefined>(undefined);
  const recurso = useRecurso<PainelResposta>(
    () => api.painel(run),
    [run],
    intervalo,
  );

  const statusAtual = recurso.dados?.execucao?.status;
  useEffect(() => {
    setIntervalo(statusAtual === 'em_execucao' ? 4000 : undefined);
  }, [statusAtual]);

  const dados = recurso.dados;

  if (recurso.carregando && !dados) return <Carregando />;
  if (recurso.erro && !dados) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }
  if (!dados) return null;

  const { execucao, etapas, kpis, aviso, historico } = dados;

  return (
    <section className="tela">
      <TituloTela
        titulo="Coleta diária"
        descricao={
          <>
            Pesquisa de preços InfoPrice · run={dados.runDate} ·{' '}
            {execucao ? rotuloTipo(execucao.tipo) : 'sem execução registrada'}
          </>
        }
      />

      <div className="grade-kpi">
        <Kpi
          rotulo="Execução de hoje"
          valor={kpis.status}
          nota={kpis.janela}
          cor={execucao ? corDoStatus(execucao.status) : undefined}
        />
        <Kpi
          rotulo="Arquivos ingeridos"
          valor={kpis.arquivos}
          nota={kpis.bytes}
        />
        <Kpi rotulo="Linhas persistidas" valor={kpis.linhas} nota={kpis.linhasNota} />
        <Kpi rotulo="Rejeições" valor={kpis.rejeicoes} nota="ctl_rejeicao" />
      </div>

      {aviso && (
        <Aviso tag={aviso.tag} tom={aviso.tom}>
          {aviso.texto}
        </Aviso>
      )}

      <Painel
        titulo={`Etapas do processo · run=${dados.runDate}`}
        acao={
          execucao ? (
            <span className="cartao__nota--mono">execução #{execucao.id}</span>
          ) : undefined
        }
      >
        {etapas.length === 0 ? (
          <Vazio>Nenhuma etapa registrada para este run.</Vazio>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {etapas.map((e) => (
              <div className="etapa" key={e.ordem}>
                <span className="etapa__hora">
                  {e.iniciadoEm ? hora(e.iniciadoEm) : '—'}
                </span>
                <span className={classeEtapa(e.status)} />
                <span className="etapa__nome">{e.nome}</span>
                <span className="etapa__detalhe" title={e.detalhe ?? undefined}>
                  {e.detalhe ??
                    (e.status === 'em_curso' ? 'em andamento' : 'aguardando')}
                </span>
                <span
                  className={`etapa__duracao${
                    e.status === 'em_curso'
                      ? ' etapa__duracao--em_curso'
                      : e.status === 'erro'
                        ? ' etapa__duracao--erro'
                        : ''
                  }`}
                >
                  {e.status === 'em_curso'
                    ? 'em curso'
                    : e.status === 'erro'
                      ? 'erro'
                      : e.status === 'pendente'
                        ? '—'
                        : duracaoCurta(e.duracaoMs)}
                </span>
              </div>
            ))}
          </div>
        )}
      </Painel>

      <Painel
        titulo="Histórico de execuções"
        nota="clique em uma linha para ver a rastreabilidade"
      >
        {historico.length === 0 ? (
          <Vazio>Nenhuma execução registrada ainda.</Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>run</th>
                <th>janela</th>
                <th>tipo</th>
                <th className="num">arquivos</th>
                <th className="num">linhas gravadas</th>
                <th className="num">rejeições</th>
                <th className="num">duração</th>
                <th className="num">status</th>
              </tr>
            </thead>
            <tbody>
              {historico.map((r) => (
                <tr
                  key={r.id}
                  className="clicavel"
                  onClick={() => aoAbrirExecucao(r.id)}
                >
                  <td className="mono-forte">run={r.runDate}</td>
                  <td className="mono suave">
                    {horaCurta(r.iniciadoEm)} →{' '}
                    {r.finalizadoEm ? horaCurta(r.finalizadoEm) : 'agora'}
                  </td>
                  <td>{rotuloTipo(r.tipo)}</td>
                  <td className="num mono">
                    {r.arquivosIngeridos} / {r.arquivosVistos}
                  </td>
                  <td className="num mono">{numeroBR(r.linhasGravadas)}</td>
                  <td
                    className="num mono"
                    style={
                      r.linhasRejeitadas > 0
                        ? { color: 'oklch(0.5 0.12 60)' }
                        : undefined
                    }
                  >
                    {numeroBR(r.linhasRejeitadas)}
                  </td>
                  <td className="num mono suave">{duracaoBR(r.duracaoMs)}</td>
                  <td className="num">
                    <Pilula tom={tomDoStatus(r.status)}>
                      {rotuloStatus(r.status)}
                    </Pilula>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Painel>
    </section>
  );
}
