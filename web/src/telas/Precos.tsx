import { useEffect, useState } from 'react';
import type { PrecosResposta } from '@infoprice/shared';
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
import {
  dataBR,
  dataHoraBR,
  hoje,
  moedaBR,
  numeroBR,
} from '../util.js';

interface Filtros {
  data: string;
  uf: string;
  busca: string;
  tipo: string;
}

export function Precos({
  aoAbrirExecucao,
  aoAvisar,
}: {
  aoAbrirExecucao: (id: number) => void;
  aoAvisar: (texto: string, erro?: boolean) => void;
}) {
  const [rascunho, setRascunho] = useState<Filtros>({
    data: hoje(),
    uf: 'Todas',
    busca: '',
    tipo: 'Todos',
  });
  // Os filtros só valem depois do "Buscar": digitar não dispara consulta.
  const [aplicados, setAplicados] = useState<Filtros>(rascunho);
  const [ufs, setUfs] = useState<string[]>([]);

  useEffect(() => {
    api.ufs().then(setUfs).catch(() => setUfs([]));
  }, []);

  const recurso = useRecurso<PrecosResposta>(
    () =>
      api.precos({
        data: aplicados.data || undefined,
        uf: aplicados.uf,
        busca: aplicados.busca || undefined,
        tipo: aplicados.tipo,
        limite: 50,
      }),
    [aplicados],
  );

  const buscar = () => {
    setAplicados({ ...rascunho });
    aoAvisar('Consulta enviada ao banco');
  };

  const d = recurso.dados;

  return (
    <section className="tela" style={{ gap: 20 }}>
      <TituloTela
        titulo="Consulta dos preços gravados"
        descricao="Leitura direta de fact_preco_coletado. Toda linha aponta para a execução e o arquivo que a originaram."
      />

      <div className="filtros">
        <label className="campo">
          data da coleta
          <input
            type="date"
            value={rascunho.data}
            onChange={(e) => setRascunho({ ...rascunho, data: e.target.value })}
          />
        </label>

        <label className="campo">
          uf
          <select
            value={rascunho.uf}
            onChange={(e) => setRascunho({ ...rascunho, uf: e.target.value })}
          >
            <option>Todas</option>
            {ufs.map((uf) => (
              <option key={uf}>{uf}</option>
            ))}
          </select>
        </label>

        <label className="campo campo--largo">
          gtin ou descrição
          <input
            type="text"
            placeholder="7891000…"
            value={rascunho.busca}
            onChange={(e) => setRascunho({ ...rascunho, busca: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') buscar();
            }}
          />
        </label>

        <label className="campo">
          tipo de preço
          <select
            value={rascunho.tipo}
            onChange={(e) => setRascunho({ ...rascunho, tipo: e.target.value })}
          >
            <option>Todos</option>
            <option>Regular</option>
            <option>Promoção</option>
          </select>
        </label>

        <div style={{ flex: 1 }} />

        <button className="botao botao--primario" onClick={buscar}>
          Buscar
        </button>
        <a
          className="botao"
          href={api.urlPrecosCsv({
            data: aplicados.data,
            uf: aplicados.uf,
            busca: aplicados.busca,
            tipo: aplicados.tipo,
          })}
          target="_blank"
          rel="noreferrer"
        >
          Exportar CSV
        </a>
      </div>

      {recurso.carregando && !d && <Carregando />}
      {recurso.erro && !d && (
        <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />
      )}

      {d && (
        <Painel
          titulo={`${numeroBR(d.total)} linhas${
            aplicados.uf !== 'Todas' ? ` em ${aplicados.uf}` : ''
          } · ${dataBR(aplicados.data)}`}
          acao={
            <span className="cartao__nota--mono">
              exibindo {d.exibindo}
              {d.atualizadoEm ? ` · atualizado ${dataHoraBR(d.atualizadoEm)}` : ''}
            </span>
          }
        >
          {d.linhas.length === 0 ? (
            <Vazio>Nenhum preço encontrado com esses filtros.</Vazio>
          ) : (
            <table className="tabela">
              <thead>
                <tr>
                  <th>gtin</th>
                  <th>descrição</th>
                  <th>loja</th>
                  <th className="num">preço</th>
                  <th>tipo</th>
                  <th>coleta</th>
                  <th className="num">origem</th>
                </tr>
              </thead>
              <tbody>
                {d.linhas.map((p) => (
                  <tr
                    key={p.id}
                    className="clicavel"
                    onClick={() => aoAbrirExecucao(p.idExecucao)}
                  >
                    <td className="mono">{p.gtin}</td>
                    <td>{p.descricao}</td>
                    <td className="mono suave">
                      {p.idLoja}
                      {p.rede ? ` · rede ${p.rede}` : ''}
                    </td>
                    <td
                      className="num mono"
                      style={{ fontSize: 12.5, fontWeight: 500 }}
                    >
                      {moedaBR(p.preco)}
                    </td>
                    <td>
                      <Pilula
                        tom={p.tipoPreco === 'Promoção' ? 'exec' : 'neutro'}
                      >
                        {p.tipoPreco}
                      </Pilula>
                    </td>
                    <td className="mono suave">{dataBR(p.dataColeta)}</td>
                    <td
                      className="num mono"
                      style={{ fontSize: 11, color: 'var(--azul)' }}
                      title={p.arquivo}
                    >
                      #{p.idExecucao} · {p.arquivo.replace(/^.*_(\d+)\.csv\.gz$/, '_$1')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Painel>
      )}
    </section>
  );
}
