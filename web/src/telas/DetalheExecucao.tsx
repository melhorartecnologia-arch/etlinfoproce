import { useState } from 'react';
import type { DetalheExecucaoResposta } from '@infoprice/shared';
import { api } from '../api.js';
import { useRecurso } from '../hooks.js';
import {
  CaixaErro,
  Carregando,
  MiniCartao,
  Painel,
  Par,
  Pilula,
  TituloTela,
  Vazio,
} from '../componentes/base.js';
import {
  abreviarHash,
  bytesBR,
  hora,
  numeroBR,
  rotuloStatus,
  tomDoStatus,
} from '../util.js';

export function DetalheExecucao({
  id,
  podeOperar,
  aoVoltar,
  aoAvisar,
  aoRecarregarStatus,
}: {
  id: number | null;
  podeOperar: boolean;
  aoVoltar: () => void;
  aoAvisar: (texto: string, erro?: boolean) => void;
  aoRecarregarStatus: () => void;
}) {
  const [mostrarSql, setMostrarSql] = useState(true);

  const recurso = useRecurso<DetalheExecucaoResposta | null>(
    async () => {
      if (id !== null) return api.execucao(id);
      // Sem execução escolhida, abre a mais recente — é o que o operador quer
      // ver ao entrar por "Execução passo a passo".
      const painel = await api.painel();
      const ultima = painel.execucao ?? painel.historico[0];
      return ultima ? api.execucao(ultima.id) : null;
    },
    [id],
  );

  if (recurso.carregando) return <Carregando />;
  if (recurso.erro) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }
  if (!recurso.dados) {
    return <Vazio>Nenhuma execução registrada ainda.</Vazio>;
  }

  const d = recurso.dados;
  const e = d.execucao;

  const reprocessar = async () => {
    try {
      const r = await api.reprocessarRun(e.id);
      aoAvisar(r.mensagem);
      aoRecarregarStatus();
    } catch (erro) {
      aoAvisar(erro instanceof Error ? erro.message : String(erro), true);
    }
  };

  const reprocessarArquivo = async (idArquivo: number, nome: string) => {
    try {
      const r = await api.reprocessarArquivo(idArquivo);
      aoAvisar(r.mensagem);
      aoRecarregarStatus();
    } catch (erro) {
      aoAvisar(
        erro instanceof Error ? `${nome}: ${erro.message}` : String(erro),
        true,
      );
    }
  };

  return (
    <section className="tela" style={{ gap: 20 }}>
      <TituloTela
        voltar={{ rotulo: 'histórico de execuções', aoClicar: aoVoltar }}
        titulo={`Execução #${e.id} · run=${e.runDate}`}
        descricao={d.resumo}
        acoes={
          <>
            <a
              className="botao"
              href={api.urlAuditoriaCsv(e.id)}
              target="_blank"
              rel="noreferrer"
            >
              Auditoria CSV
            </a>
            <a
              className="botao"
              href={api.urlAuditoriaPdf(e.id)}
              target="_blank"
              rel="noreferrer"
            >
              Auditoria PDF
            </a>
            {podeOperar && (
              <button className="botao botao--acento" onClick={reprocessar}>
                Reprocessar run
              </button>
            )}
          </>
        }
      />

      <div className="grade-kpi">
        {d.cards.map((c) => (
          <MiniCartao
            key={c.rotulo}
            rotulo={c.rotulo}
            valor={c.valor}
            nota={c.nota}
          />
        ))}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)',
          gap: 16,
          alignItems: 'start',
        }}
        className="detalhe-colunas"
      >
        <div className="log">
          <div className="log__cabecalho">
            <span className="log__rotulo">log de execução</span>
            <span className="log__meta">
              ctl_execucao_log · {numeroBR(d.totalEventos)} eventos
            </span>
          </div>
          {d.log.length === 0 ? (
            <span className="log__msg">sem eventos registrados</span>
          ) : (
            d.log.map((l) => (
              <div className="log__linha" key={l.id}>
                <span className="log__hora">{hora(l.ts)}</span>
                <span className={`log__nivel log__nivel--${l.nivel}`}>
                  {l.nivel}
                </span>
                <span className="log__msg">{l.mensagem}</span>
              </div>
            ))
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="cartao cartao__corpo" style={{ gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              Controle de idempotência
            </h2>
            {d.idempotencia.map((i) => (
              <Par key={i.chave} chave={i.chave} valor={i.valor} />
            ))}
          </div>

          <div className="cartao cartao__corpo" style={{ gap: 10 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
                Comando de persistência
              </h2>
              <button
                className="botao botao--miudo"
                onClick={() => setMostrarSql((v) => !v)}
              >
                {mostrarSql ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>
            {mostrarSql && <pre className="sql">{d.sqlPersistencia}</pre>}
          </div>
        </div>
      </div>

      <Painel
        titulo="Arquivos da execução"
        nota="hash conferido na origem e após descompactação"
      >
        {d.arquivos.length === 0 ? (
          <Vazio>Nenhum arquivo associado a esta execução.</Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>arquivo</th>
                <th className="num">tamanho</th>
                <th>sha-256</th>
                <th className="num">lidas</th>
                <th className="num">gravadas</th>
                <th className="num">rejeitadas</th>
                <th>destino</th>
                <th>status</th>
                <th className="num">ações</th>
              </tr>
            </thead>
            <tbody>
              {d.arquivos.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.nome}</td>
                  <td className="num mono suave">{bytesBR(a.tamanhoBytes)}</td>
                  <td className="mono suave" title={a.sha256 ?? undefined}>
                    {abreviarHash(a.sha256)}
                  </td>
                  <td className="num mono">{numeroBR(a.linhasLidas)}</td>
                  <td className="num mono">{numeroBR(a.linhasGravadas)}</td>
                  <td
                    className="num mono"
                    style={
                      a.linhasRejeitadas > 0
                        ? { color: 'oklch(0.5 0.12 60)' }
                        : undefined
                    }
                  >
                    {numeroBR(a.linhasRejeitadas)}
                  </td>
                  <td className="mono suave">{a.destino ?? '—'}</td>
                  <td>
                    <Pilula tom={a.status === 'ingerido' ? 'ok' : 'neutro'}>
                      {a.status === 'ingerido' ? 'Ingerido' : a.status}
                    </Pilula>
                  </td>
                  <td>
                    <div className="acoes">
                      {!podeOperar && <span className="suave">—</span>}
                      {podeOperar && (
                      <>
                      <a
                        className={`botao botao--miudo${a.temCopiaLocal ? '' : ' desabilitado'}`}
                        href={api.urlDownloadArquivo(a.id)}
                        target="_blank"
                        rel="noreferrer"
                        aria-disabled={!a.temCopiaLocal}
                        title={
                          a.temCopiaLocal
                            ? 'Baixa a cópia local, idêntica à da origem'
                            : 'Sem cópia local — reprocesse para baixar de novo'
                        }
                      >
                        Baixar bruto
                      </a>
                      <button
                        className="botao botao--miudo"
                        onClick={() => reprocessarArquivo(a.id, a.nome)}
                      >
                        Reprocessar
                      </button>
                      </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Painel>

      <div className="cartao cartao__corpo">
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          Resumo da execução
        </h2>
        <div className="pares-2">
          <Par chave="Status" valor={
            <Pilula tom={tomDoStatus(e.status)}>{rotuloStatus(e.status)}</Pilula>
          } />
          <Par chave="Gatilho" valor={e.gatilho} />
          <Par chave="Linhas em staging" valor={numeroBR(e.linhasStaging)} />
          <Par chave="Linhas gravadas" valor={numeroBR(e.linhasGravadas)} />
          <Par chave="Inseridas" valor={numeroBR(e.linhasInseridas)} />
          <Par chave="Atualizadas" valor={numeroBR(e.linhasAtualizadas)} />
          <Par chave="Rejeitadas" valor={numeroBR(e.linhasRejeitadas)} />
          <Par chave="Bytes baixados" valor={bytesBR(e.bytesBaixados)} />
          {e.erro && <Par chave="Erro" valor={e.erro} />}
        </div>
      </div>
    </section>
  );
}
