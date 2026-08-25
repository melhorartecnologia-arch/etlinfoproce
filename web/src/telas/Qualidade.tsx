import type { QualidadeResposta } from '@infoprice/shared';
import { api } from '../api.js';
import { useRecurso } from '../hooks.js';
import {
  CaixaErro,
  Carregando,
  Painel,
  TituloTela,
  Vazio,
} from '../componentes/base.js';
import { corDoMotivo, numeroBR, percentualBR } from '../util.js';

export function Qualidade() {
  const recurso = useRecurso<QualidadeResposta>(() => api.qualidade(), []);

  if (recurso.carregando) return <Carregando />;
  if (recurso.erro) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }
  if (!recurso.dados) return null;

  const d = recurso.dados;
  const maior = d.motivos[0]?.quantidade ?? 1;

  return (
    <section className="tela" style={{ gap: 20 }}>
      <TituloTela
        titulo="Qualidade e rejeições"
        descricao={
          d.idExecucao === null
            ? `Nenhuma execução registrada para run=${d.runDate}.`
            : `${numeroBR(d.totalRejeitadas)} de ${numeroBR(
                d.totalLinhas,
              )} linhas do run=${d.runDate} não foram promovidas para a tabela final. Toda linha rejeitada guarda o payload original.`
        }
      />

      <div className="cartao cartao__corpo">
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Motivos</h2>
        {d.motivos.length === 0 ? (
          <Vazio>Nenhuma rejeição neste run.</Vazio>
        ) : (
          d.motivos.map((m, i) => (
            <div className="motivo" key={m.nome}>
              <span className="motivo__nome">{m.nome}</span>
              <div className="motivo__trilho">
                <div
                  className="motivo__barra"
                  style={{
                    width: `${Math.max(2, (m.quantidade / maior) * 100)}%`,
                    background: corDoMotivo(i),
                  }}
                />
              </div>
              <span className="motivo__qtd">{numeroBR(m.quantidade)}</span>
            </div>
          ))
        )}
      </div>

      <Painel
        titulo="Linhas rejeitadas"
        acao={
          <a
            className="botao botao--miudo"
            href={api.urlRejeicoesCsv(d.runDate)}
            target="_blank"
            rel="noreferrer"
          >
            Exportar rejeições (CSV)
          </a>
        }
      >
        {d.rejeicoes.length === 0 ? (
          <Vazio>Nenhuma linha rejeitada neste run.</Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>arquivo · linha</th>
                <th>motivo</th>
                <th>payload original</th>
                <th className="num">tratamento</th>
              </tr>
            </thead>
            <tbody>
              {d.rejeicoes.map((r) => (
                <tr key={r.id}>
                  <td
                    className="mono suave"
                    style={{ fontSize: 11, whiteSpace: 'nowrap' }}
                  >
                    {r.arquivo} · linha {numeroBR(r.numeroLinha)}
                  </td>
                  <td>{r.motivo}</td>
                  <td
                    className="mono suave"
                    style={{
                      fontSize: 11,
                      maxWidth: 380,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={r.payload}
                  >
                    {r.payload}
                  </td>
                  <td className="num" style={{ fontSize: 12 }}>
                    {r.tratamento}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Painel>

      {d.idExecucao !== null && d.totalLinhas > 0 && (
        <div className="cartao cartao__corpo">
          <div className="pares-2">
            <div className="par">
              <span className="par__chave">Percentual rejeitado</span>
              <span className="par__valor">{percentualBR(d.percentual)}</span>
            </div>
            <div className="par">
              <span className="par__chave">Execução de origem</span>
              <span className="par__valor">#{d.idExecucao}</span>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
