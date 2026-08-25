import { useEffect, useState } from 'react';
import type { LinhagemResposta } from '@infoprice/shared';
import { api } from '../api.js';
import { useRecurso } from '../hooks.js';
import {
  CaixaErro,
  Carregando,
  Painel,
  Par,
  TituloTela,
  Vazio,
} from '../componentes/base.js';
import { numeroBR } from '../util.js';

const COR_TOM: Record<string, string> = {
  neutro: 'oklch(0.22 0.01 85)',
  atencao: 'oklch(0.52 0.14 60)',
  ok: 'oklch(0.6 0.13 150)',
};

export function Linhagem({ aoAbrirExecucao }: { aoAbrirExecucao: (id: number) => void }) {
  const recurso = useRecurso<LinhagemResposta | null>(async () => {
    const painel = await api.painel();
    const ultima = painel.execucao ?? painel.historico[0];
    return ultima ? api.linhagem(ultima.id) : null;
  }, []);

  const idExecucao = recurso.dados?.idExecucao;
  const [inverso, setInverso] = useState<{
    id: string | null;
    campos: { chave: string; valor: string }[];
  } | null>(null);

  useEffect(() => {
    if (!idExecucao) return;
    let ativo = true;
    api
      .linhagemExemplo(idExecucao)
      .then((r) => {
        if (ativo) setInverso(r);
      })
      .catch(() => {
        if (ativo) setInverso(null);
      });
    return () => {
      ativo = false;
    };
  }, [idExecucao]);

  if (recurso.carregando) return <Carregando />;
  if (recurso.erro) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }
  if (!recurso.dados) {
    return <Vazio>Nenhuma execução para rastrear ainda.</Vazio>;
  }

  const d = recurso.dados;

  return (
    <section className="tela" style={{ gap: 20 }}>
      <TituloTela
        titulo="Linhagem do dado"
        descricao={
          <>
            Do arquivo recebido até a linha gravada, com a contagem de cada
            passagem. run={d.runDate}.
          </>
        }
      />

      <div className="fluxo">
        {d.fluxo.map((f) => (
          <div className="fluxo__etapa" key={f.etapa}>
            <span className="fluxo__rotulo">{f.etapa}</span>
            <span className="fluxo__objeto">{f.objeto}</span>
            <span
              className="fluxo__qtd"
              style={{ color: COR_TOM[f.tom] ?? COR_TOM.neutro }}
            >
              {numeroBR(f.quantidade)}
            </span>
            <span className="fluxo__nota">{f.nota}</span>
          </div>
        ))}
      </div>

      <Painel titulo="Contagem por arquivo">
        {d.porArquivo.length === 0 ? (
          <Vazio>Sem arquivos nesta execução.</Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>arquivo</th>
                <th className="num">no arquivo</th>
                <th className="num">staging</th>
                <th className="num">rejeitadas</th>
                <th className="num">inseridas</th>
                <th className="num">atualizadas</th>
                <th>partição</th>
                <th className="num">execução</th>
              </tr>
            </thead>
            <tbody>
              {d.porArquivo.map((l) => (
                <tr key={l.idArquivo}>
                  <td className="mono">{l.arquivo}</td>
                  <td className="num mono">{numeroBR(l.noArquivo)}</td>
                  <td className="num mono">{numeroBR(l.staging)}</td>
                  <td
                    className="num mono"
                    style={{ color: 'oklch(0.5 0.12 60)' }}
                  >
                    {numeroBR(l.rejeitadas)}
                  </td>
                  <td className="num mono">{numeroBR(l.inseridas)}</td>
                  <td className="num mono">{numeroBR(l.atualizadas)}</td>
                  <td className="mono suave">{l.particao}</td>
                  <td className="num mono">
                    <button
                      className="botao--texto"
                      onClick={() => aoAbrirExecucao(l.idExecucao)}
                    >
                      #{l.idExecucao}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Painel>

      <div className="cartao cartao__corpo">
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
            Caminho inverso: de uma linha gravada até o arquivo
          </h2>
          <span className="cartao__nota--mono">
            fact_preco_coletado
            {inverso?.id ? ` · id ${inverso.id.slice(0, 8)}…` : ''}
          </span>
        </div>

        {!inverso || inverso.campos.length === 0 ? (
          <Vazio>Nenhuma linha gravada para rastrear.</Vazio>
        ) : (
          <div className="pares-2">
            {inverso.campos.map((c) => (
              <Par key={c.chave} chave={c.chave} valor={c.valor} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
