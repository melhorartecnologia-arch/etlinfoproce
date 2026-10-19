import { useState, type FormEvent } from 'react';
import type { ResumoBaseResposta } from '@infoprice/shared';
import { api } from '../api.js';
import { useRecurso } from '../hooks.js';
import {
  Aviso,
  CaixaErro,
  Carregando,
  Par,
  TituloTela,
} from '../componentes/base.js';
import { dataHoraBR, numeroBR } from '../util.js';

/**
 * Zerar a base: apaga todo o histórico de dados e de metadados. Fica atrás da
 * frase digitada e da senha de quem pede; o servidor confere as duas.
 */
export function Manutencao({
  aoAvisar,
  aoZerar,
}: {
  aoAvisar: (texto: string, erro?: boolean) => void;
  aoZerar: () => void;
}) {
  const recurso = useRecurso<ResumoBaseResposta>(() => api.resumoBase(), []);
  const [frase, setFrase] = useState('');
  const [senha, setSenha] = useState('');
  const [apagarArquivos, setApagarArquivos] = useState(false);
  const [zerando, setZerando] = useState(false);

  if (recurso.carregando) return <Carregando />;
  if (recurso.erro) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }
  if (!recurso.dados) return null;

  const d = recurso.dados;
  const c = d.contagens;
  const pronto =
    frase === d.frase && senha.length > 0 && !zerando && !d.coletaEmAndamento;

  const zerar = async (e: FormEvent) => {
    e.preventDefault();
    if (!pronto) return;
    setZerando(true);
    try {
      const r = await api.zerarBase({ confirmacao: frase, senha, apagarArquivos });
      aoAvisar(r.mensagem);
      aoZerar();
    } catch (erro) {
      aoAvisar(erro instanceof Error ? erro.message : String(erro), true);
      setZerando(false);
      setSenha('');
      recurso.recarregar();
    }
  };

  return (
    <section className="tela" style={{ gap: 20, maxWidth: 820 }}>
      <TituloTela
        titulo="Zerar a base"
        descricao="Apaga todo o histórico de dados e de metadados e deixa a aplicação como recém-instalada, mantendo os usuários."
      />

      {d.coletaEmAndamento && (
        <Aviso tag="em andamento" tom="atencao">
          Há uma coleta em andamento. Aguarde o término para zerar a base.
        </Aviso>
      )}

      <div className="cartao cartao__corpo" style={{ gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Será apagado</h2>
        <Par chave="Execuções, etapas e log" valor={`${numeroBR(c.execucoes)} execuções · ${numeroBR(c.eventosLog)} eventos`} />
        <Par chave="Inventário de arquivos" valor={numeroBR(c.arquivos)} />
        <Par chave="Preços gravados" valor={`~${numeroBR(c.precos)} · todas as partições mensais`} />
        <Par chave="Staging e rejeições" valor={`${numeroBR(c.rejeicoes)} rejeições`} />
        <Par chave="Incidentes" valor={`${numeroBR(c.incidentes)} · o código volta a #201`} />
        <Par chave="Lojas (dim_loja)" valor={numeroBR(c.lojas)} />
        <Par chave="Tentativas de login" valor={numeroBR(c.tentativasLogin)} />
      </div>

      <div className="cartao cartao__corpo" style={{ gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Fica</h2>
        <Par chave="Usuários e sessões" valor={`${numeroBR(c.usuarios)} usuários — você continua conectado`} />
        <Par chave="Configuração" valor="regras de alerta, agendamento e schema do banco" />
        <Par
          chave="Registro dos resets"
          valor={
            d.ultimoReset
              ? `último em ${dataHoraBR(d.ultimoReset.executadoEm)} por ${d.ultimoReset.executadoPor} (${d.ultimoReset.origem})`
              : 'nenhum reset anterior'
          }
        />
      </div>

      <form className="cartao cartao__corpo zona-perigo" style={{ gap: 14 }} onSubmit={zerar}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Confirmar</h2>

        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={apagarArquivos}
            onChange={(e) => setApagarArquivos(e.target.checked)}
          />
          <span>
            Apagar também as cópias locais dos arquivos baixados
            <span className="suave mono" style={{ display: 'block', fontSize: 11.5 }}>
              {d.areaTemporaria} · o fornecedor guarda só 5 dias: o que for mais
              antigo não poderá ser baixado de novo
            </span>
          </span>
        </label>

        <label className="campo campo--largo">
          digite {d.frase}
          <input
            value={frase}
            onChange={(e) => setFrase(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <label className="campo campo--largo">
          sua senha
          <input
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        <div>
          <button className="botao botao--perigo" type="submit" disabled={!pronto}>
            {zerando ? 'Zerando…' : 'Zerar a base'}
          </button>
        </div>

        <p className="suave" style={{ margin: 0, fontSize: 12 }}>
          Não há como desfazer. Para apagar também os usuários e voltar ao estado
          de instalação, use o comando <span className="mono">zerar-base --incluir-usuarios</span> no servidor.
        </p>
      </form>
    </section>
  );
}
