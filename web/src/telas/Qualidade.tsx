import { useState } from 'react';
import type {
  DetalheRejeicaoResposta,
  QualidadeResposta,
  RejeicaoExplicada,
} from '@infoprice/shared';
import { api, type FiltroQualidade } from '../api.js';
import { useRecurso } from '../hooks.js';
import {
  CaixaErro,
  Carregando,
  Painel,
  TituloTela,
  Vazio,
} from '../componentes/base.js';
import { corDoMotivo, dataBR, numeroBR, percentualBR } from '../util.js';

/**
 * Qualidade e rejeições: o que as regras barraram em uma execução, com a
 * explicação de cada linha e a linha original coluna a coluna.
 */
export function Qualidade() {
  const [filtro, setFiltro] = useState<FiltroQualidade>({});
  const [pagina, setPagina] = useState(1);
  const [busca, setBusca] = useState('');
  const [aberta, setAberta] = useState<number | null>(null);

  const recurso = useRecurso<QualidadeResposta>(
    () => api.qualidade({ ...filtro, pagina }),
    [JSON.stringify(filtro), pagina],
  );

  const mudar = (novo: Partial<FiltroQualidade>) => {
    setFiltro((f) => ({ ...f, ...novo }));
    setPagina(1);
    setAberta(null);
  };

  if (recurso.carregando && !recurso.dados) return <Carregando />;
  if (recurso.erro && !recurso.dados) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }
  if (!recurso.dados) return null;

  const d = recurso.dados;
  const maior = d.motivos[0]?.quantidade ?? 1;
  const filtroAtual: FiltroQualidade = { ...filtro, execucao: d.idExecucao ?? undefined };
  const inicio = d.filtradas === 0 ? 0 : (d.pagina - 1) * d.porPagina + 1;
  const fim = Math.min(d.pagina * d.porPagina, d.filtradas);
  const temFiltro = Boolean(filtro.motivo || filtro.arquivo || filtro.busca);

  return (
    <section className="tela" style={{ gap: 20 }}>
      <TituloTela
        titulo="Qualidade e rejeições"
        descricao={
          d.idExecucao === null
            ? 'Nenhuma execução registrada ainda.'
            : `${numeroBR(d.totalRejeitadas)} de ${numeroBR(d.totalLinhas)} linhas ` +
              `(${percentualBR(d.percentual)}) da execução #${d.idExecucao} · run=${d.runDate} ` +
              'não foram para a tabela final. Clique numa linha para ver o original coluna a coluna.'
        }
        acoes={
          <label className="campo">
            execução
            <select
              value={d.idExecucao ?? ''}
              onChange={(e) => mudar({ execucao: Number(e.target.value), motivo: undefined, arquivo: undefined })}
            >
              {d.execucoes.map((e) => (
                <option key={e.id} value={e.id}>
                  #{e.id} · run={e.runDate} · {numeroBR(e.linhasRejeitadas)} rejeições · {e.status}
                </option>
              ))}
            </select>
          </label>
        }
      />

      <div className="cartao cartao__corpo">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Motivos</h2>
          <span className="suave" style={{ fontSize: 12 }}>clique para filtrar</span>
        </div>
        {d.motivos.length === 0 ? (
          <Vazio>Nenhuma rejeição nesta execução.</Vazio>
        ) : (
          d.motivos.map((m, i) => (
            <div
              className={`motivo motivo--filtro${filtro.motivo === m.nome ? ' motivo--ativo' : ''}`}
              key={m.nome}
              onClick={() => mudar({ motivo: filtro.motivo === m.nome ? undefined : m.nome })}
            >
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

      <form
        className="filtros"
        onSubmit={(e) => {
          e.preventDefault();
          mudar({ busca: busca.trim() || undefined });
        }}
      >
        <label className="campo">
          arquivo
          <select
            value={filtro.arquivo ?? ''}
            onChange={(e) => mudar({ arquivo: e.target.value || undefined })}
          >
            <option value="">Todos</option>
            {d.arquivos.map((a) => (
              <option key={a.nome} value={a.nome}>
                {a.nome} ({numeroBR(a.quantidade)})
              </option>
            ))}
          </select>
        </label>
        <label className="campo campo--largo">
          procurar na linha
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="GTIN, loja, descrição…"
          />
        </label>
        <button className="botao botao--primario" type="submit">
          Buscar
        </button>
        {temFiltro && (
          <button
            className="botao"
            type="button"
            onClick={() => {
              setBusca('');
              mudar({ motivo: undefined, arquivo: undefined, busca: undefined });
            }}
          >
            Limpar filtros
          </button>
        )}
        <div style={{ flex: 1 }} />
        {d.idExecucao !== null && (
          <a
            className="botao"
            href={api.urlRejeicoesCsv(filtroAtual)}
            target="_blank"
            rel="noreferrer"
          >
            Exportar CSV{temFiltro ? ' (filtrado)' : ''}
          </a>
        )}
      </form>

      <Painel
        titulo={`Linhas rejeitadas${filtro.motivo ? ` · ${filtro.motivo}` : ''}`}
        acao={
          d.filtradas > 0 ? (
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="cartao__nota--mono">
                {numeroBR(inicio)}–{numeroBR(fim)} de {numeroBR(d.filtradas)}
              </span>
              <button
                className="botao botao--miudo"
                disabled={d.pagina <= 1}
                onClick={() => setPagina(d.pagina - 1)}
              >
                ← anterior
              </button>
              <button
                className="botao botao--miudo"
                disabled={fim >= d.filtradas}
                onClick={() => setPagina(d.pagina + 1)}
              >
                próxima →
              </button>
            </span>
          ) : undefined
        }
      >
        {d.rejeicoes.length === 0 ? (
          <Vazio>{temFiltro ? 'Nenhuma rejeição com esses filtros.' : 'Nenhuma linha rejeitada nesta execução.'}</Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>arquivo · linha</th>
                <th>motivo</th>
                <th>por quê</th>
                <th title="GTIN · loja · preço · data">valores lidos</th>
              </tr>
            </thead>
            <tbody>
              {d.rejeicoes.map((r) => (
                <LinhaRejeicao
                  key={r.id}
                  r={r}
                  aberta={aberta === r.id}
                  aoAlternar={() => setAberta(aberta === r.id ? null : r.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </Painel>
    </section>
  );
}

function LinhaRejeicao({
  r,
  aberta,
  aoAlternar,
}: {
  r: RejeicaoExplicada;
  aberta: boolean;
  aoAlternar: () => void;
}) {
  const c = r.campos;
  return (
    <>
      <tr className="clicavel" onClick={aoAlternar} aria-expanded={aberta}>
        <td className="mono" style={{ whiteSpace: 'nowrap' }}>
          <span title={r.arquivo}>
            {aberta ? '▾' : '▸'} {r.arquivo.length > 26 ? `…${r.arquivo.slice(-24)}` : r.arquivo}
          </span>{' '}
          · {numeroBR(r.numeroLinha)}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>{r.motivo}</td>
        <td className="explicacao" style={{ minWidth: 320 }}>{r.explicacao}</td>
        <td className="mono suave" style={{ fontSize: 11.5, minWidth: 150 }}>
          {Object.keys(c).length === 0
            ? '—'
            : [c.gtin, c.id_loja, c.preco, c.data_coleta && dataBR(c.data_coleta)]
                .map((v) => v || '—')
                .join(' · ')}
        </td>
      </tr>
      {aberta && (
        <tr>
          <td colSpan={4}>
            <DetalheRejeicao id={r.id} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Colunas do arquivo que alimentam cada motivo — destacadas no detalhe. */
const COLUNAS_DO_MOTIVO: Record<string, string[]> = {
  'GTIN inválido no dígito verificador': ['gtin'],
  'Preço menor ou igual a zero': ['preco_regular', 'preco_pago', 'preco'],
  'Preço acima do limite': ['preco_regular', 'preco_pago', 'preco'],
  'Loja ausente em dim_loja': ['loja', 'id_loja'],
  'Data de coleta fora da janela do run': ['data_preco', 'data_coleta'],
  'Duplicidade na chave de conflito': ['gtin', 'loja', 'data_preco'],
  'Caractere inválido na descrição': ['descricao'],
};

function DetalheRejeicao({ id }: { id: number }) {
  const recurso = useRecurso<DetalheRejeicaoResposta>(() => api.detalheRejeicao(id), [id]);
  if (recurso.carregando) return <Carregando />;
  if (recurso.erro || !recurso.dados) {
    return <CaixaErro erro={recurso.erro ?? 'sem dados'} aoTentar={recurso.recarregar} />;
  }
  const d = recurso.dados;
  const destaque = new Set(COLUNAS_DO_MOTIVO[d.rejeicao.motivo] ?? []);

  return (
    <div className="rejeicao-detalhe">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div className="campo" style={{ marginBottom: 4 }}>motivo · {d.rejeicao.tratamento.toLowerCase()}</div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{d.rejeicao.motivo}</div>
          <p className="explicacao" style={{ margin: '4px 0 0' }}>{d.rejeicao.explicacao}</p>
        </div>
        <div>
          <div className="campo" style={{ marginBottom: 4 }}>linha original, como veio</div>
          <pre className="sql" style={{ maxHeight: 160, overflow: 'auto' }}>{d.rejeicao.payload}</pre>
        </div>
        <p className="suave" style={{ margin: 0, fontSize: 11.5 }}>
          {d.cabecalhoConhecido
            ? `${d.colunasLidas} colunas lidas, ${d.colunasEsperadas} no cabeçalho · delimitador "${d.delimitador === '\t' ? 'tab' : d.delimitador}"`
            : 'O cabeçalho deste arquivo não foi guardado (processado antes desta versão): as colunas aparecem numeradas.'}
        </p>
      </div>
      <div>
        <div className="campo" style={{ marginBottom: 6 }}>coluna a coluna</div>
        <div className="rejeicao-detalhe__colunas">
          {d.colunas.map((col, i) => {
            const marcada = destaque.has(col.nome.toLowerCase()) || col.nome.startsWith('(coluna a mais');
            return (
              <div key={i} style={{ display: 'contents' }}>
                <span className={marcada ? 'destaque' : 'suave'}>{col.nome}</span>
                <span className={marcada ? 'destaque' : undefined} style={{ wordBreak: 'break-word' }}>
                  {col.valor === '' ? <span className="suave">(vazio)</span> : col.valor}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
