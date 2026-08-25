import type { InventarioResposta } from '@infoprice/shared';
import { api } from '../api.js';
import { useRecurso } from '../hooks.js';
import {
  Aviso,
  CaixaErro,
  Carregando,
  MiniCartao,
  Painel,
  Pilula,
  TituloTela,
  Vazio,
} from '../componentes/base.js';
import { bytesBR, dataHoraBR, numeroBR } from '../util.js';

/** "expira hoje" · "até 30/08" · "removido da origem" */
function textoRetencao(dias: number | null, expiraEm: string | null): string {
  if (dias === null || !expiraEm) return '—';
  if (dias < 0) return 'removido da origem';
  if (dias === 0) return 'expira hoje';
  const [, m, d] = expiraEm.split('-');
  return `até ${d}/${m}`;
}

function corRetencao(dias: number | null): string | undefined {
  if (dias === null) return undefined;
  if (dias < 0) return 'oklch(0.5 0.01 85)';
  if (dias <= 1) return 'oklch(0.55 0.13 60)';
  return undefined;
}

export function InventarioSftp({
  podeOperar,
  aoAvisar,
  aoRecarregarStatus,
}: {
  podeOperar: boolean;
  aoAvisar: (texto: string, erro?: boolean) => void;
  aoRecarregarStatus: () => void;
}) {
  const recurso = useRecurso<InventarioResposta>(() => api.inventario(), []);

  if (recurso.carregando) return <Carregando />;
  if (recurso.erro) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }
  if (!recurso.dados) return null;

  const d = recurso.dados;

  const reprocessar = async (pasta: string) => {
    try {
      const r = await api.reprocessarPasta(pasta);
      aoAvisar(r.mensagem);
      aoRecarregarStatus();
    } catch (erro) {
      aoAvisar(erro instanceof Error ? erro.message : String(erro), true);
    }
  };

  return (
    <section className="tela" style={{ gap: 20 }}>
      <TituloTela
        titulo="Inventário do diretório SFTP"
        descricao={`O fornecedor mantém os arquivos disponíveis por ${d.cards.retencaoDias} dias. Cada pasta run= é varrida, baixada e arquivada localmente.`}
      />

      <div className="grade-3">
        <MiniCartao
          rotulo="pastas na origem"
          valor={
            <span style={{ fontSize: 20, fontWeight: 700 }}>
              {d.cards.pastasNaOrigem}
            </span>
          }
          nota={`janela de retenção de ${d.cards.retencaoDias} dias`}
        />
        <MiniCartao
          rotulo="arquivos pendentes"
          valor={
            <span
              style={{
                fontSize: 20,
                fontWeight: 700,
                color:
                  d.cards.arquivosPendentes === 0
                    ? 'oklch(0.6 0.13 150)'
                    : 'oklch(0.55 0.13 60)',
              }}
            >
              {d.cards.arquivosPendentes}
            </span>
          }
          nota={
            d.cards.arquivosPendentes === 0
              ? 'tudo baixado e conferido'
              : 'serão retomados na próxima varredura'
          }
        />
        <MiniCartao
          rotulo="expira nas próximas 24h"
          valor={
            <span
              style={{
                fontSize: 20,
                fontWeight: 700,
                color:
                  d.cards.expiramEm24h > 0 ? 'oklch(0.55 0.13 60)' : undefined,
              }}
            >
              {d.cards.expiramEm24h}
            </span>
          }
          nota={
            d.cards.expiramEm24h > 0
              ? 'cópia local conferida'
              : 'nada expirando agora'
          }
        />
      </div>

      <Painel titulo="Pastas monitoradas">
        {d.pastas.length === 0 ? (
          <Vazio>Nenhuma pasta vista na origem ainda.</Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>pasta</th>
                <th>conteúdo</th>
                <th>visto em</th>
                <th>ingerido em</th>
                <th>retenção na origem</th>
                <th>situação</th>
                <th className="num">ações</th>
              </tr>
            </thead>
            <tbody>
              {d.pastas.map((p) => (
                <tr key={p.pasta}>
                  <td className="mono-forte">{p.pasta}</td>
                  <td>
                    {p.arquivos} arquivo{p.arquivos > 1 ? 's' : ''} ·{' '}
                    {bytesBR(p.bytes)}
                  </td>
                  <td className="mono suave">{dataHoraBR(p.vistoEm)}</td>
                  <td className="mono suave">{dataHoraBR(p.ingeridoEm)}</td>
                  <td
                    className="mono"
                    style={{ color: corRetencao(p.expiraEmDias) }}
                  >
                    {textoRetencao(p.expiraEmDias, p.expiraEm)}
                  </td>
                  <td>
                    <Pilula
                      tom={
                        p.status === 'ingerido'
                          ? 'ok'
                          : p.status === 'arquivado'
                            ? 'neutro'
                            : p.status === 'erro'
                              ? 'erro'
                              : 'atencao'
                      }
                    >
                      {p.situacao}
                    </Pilula>
                  </td>
                  <td>
                    <div className="acoes">
                      {podeOperar ? (
                        <>
                          <a
                            className="botao botao--miudo"
                            href={api.urlDownloadPasta(p.pasta)}
                            target="_blank"
                            rel="noreferrer"
                            title="Baixa as cópias locais da pasta num único .tar"
                          >
                            Baixar
                          </a>
                          <button
                            className="botao botao--miudo"
                            onClick={() => reprocessar(p.pasta)}
                          >
                            Reprocessar
                          </button>
                        </>
                      ) : (
                        <span className="suave">—</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Painel>

      {d.cargaInicial && (
        <Aviso tag="carga inicial" tom="info">
          A pasta {d.cargaInicial.pasta} trouxe o histórico completo (
          {numeroBR(d.cargaInicial.arquivos)} arquivos,{' '}
          {numeroBR(d.cargaInicial.linhas)} linhas). Desde então o fornecedor
          envia apenas dados novos, e a aplicação compara a contagem diária com
          a média dos últimos 7 dias para detectar envios incompletos.
        </Aviso>
      )}
    </section>
  );
}
