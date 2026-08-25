import type { IncidentesResposta } from '@infoprice/shared';
import { api } from '../api.js';
import { useRecurso } from '../hooks.js';
import {
  CaixaErro,
  Carregando,
  Painel,
  Pilula,
  TituloTela,
  Vazio,
} from '../componentes/base.js';
import { dataHoraBR, duracaoBR, tomDaSeveridade } from '../util.js';

export function Alertas({
  aoAvisar,
  aoRecarregarStatus,
}: {
  aoAvisar: (texto: string, erro?: boolean) => void;
  aoRecarregarStatus: () => void;
}) {
  const recurso = useRecurso<IncidentesResposta>(() => api.incidentes(), []);

  if (recurso.carregando) return <Carregando />;
  if (recurso.erro) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }
  if (!recurso.dados) return null;

  const d = recurso.dados;

  const resolver = async (codigo: string) => {
    try {
      const r = await api.resolverIncidente(codigo);
      aoAvisar(r.mensagem);
      recurso.recarregar();
      aoRecarregarStatus();
    } catch (erro) {
      aoAvisar(erro instanceof Error ? erro.message : String(erro), true);
    }
  };

  return (
    <section className="tela" style={{ gap: 20 }}>
      <TituloTela
        titulo="Alertas e incidentes"
        descricao="Cada incidente guarda a execução de origem, o que foi feito e quem encerrou."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {d.incidentes.length === 0 ? (
          <div className="cartao">
            <Vazio>Nenhum incidente registrado. Tudo em ordem.</Vazio>
          </div>
        ) : (
          d.incidentes.map((i) => {
            const aberto = i.status === 'aberto';
            const modificador = aberto
              ? i.severidade === 'Crítico'
                ? ' incidente--critico'
                : ' incidente--atencao'
              : '';

            return (
              <div className={`incidente${modificador}`} key={i.id}>
                <div className="incidente__id">
                  <span className="incidente__codigo">{i.codigo}</span>
                  <span className="alinha-inicio">
                    <Pilula tom={tomDaSeveridade(i.severidade)}>
                      {i.severidade}
                    </Pilula>
                  </span>
                </div>

                <div className="incidente__texto">
                  <span className="incidente__titulo">{i.titulo}</span>
                  <span className="incidente__detalhe">{i.detalhe}</span>
                </div>

                <div className="incidente__meta">
                  <span>{dataHoraBR(i.abertoEm)}</span>
                  <span>
                    {i.runDate ? `run=${i.runDate}` : 'sem run associado'}
                    {i.idExecucao ? ` · #${i.idExecucao}` : ''}
                  </span>
                  <span>{i.canal}</span>
                </div>

                <div className="incidente__acao">
                  <span
                    className={`incidente__status incidente__status--${
                      aberto ? 'aberto' : 'resolvido'
                    }`}
                  >
                    {aberto
                      ? 'Aberto'
                      : `Resolvido ${dataHoraBR(i.resolvidoEm)}`}
                  </span>
                  {aberto ? (
                    <button
                      className="botao botao--miudo"
                      onClick={() => resolver(i.codigo)}
                    >
                      Marcar como resolvido
                    </button>
                  ) : (
                    i.duracaoMs !== null && (
                      <span
                        style={{
                          fontFamily: 'var(--mono)',
                          fontSize: 11,
                          color: 'var(--texto-suave)',
                        }}
                      >
                        aberto por {duracaoBR(i.duracaoMs)}
                      </span>
                    )
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <Painel titulo="Regras de notificação">
        <table className="tabela">
          <thead>
            <tr>
              <th>condição</th>
              <th>severidade</th>
              <th>canal</th>
              <th className="num">destinatário</th>
            </tr>
          </thead>
          <tbody>
            {d.regras.map((r) => (
              <tr key={r.id}>
                <td>{r.condicao}</td>
                <td>
                  <Pilula tom={tomDaSeveridade(r.severidade)}>
                    {r.severidade}
                  </Pilula>
                </td>
                <td className="mono suave">{r.canal}</td>
                <td className="num mono suave">{r.destinatario}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Painel>
    </section>
  );
}
