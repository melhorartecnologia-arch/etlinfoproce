import { useCallback, useEffect, useState } from 'react';
import type { StatusResposta } from '@infoprice/shared';
import { api } from './api.js';
import { useRecurso, usePreferencia, useToast } from './hooks.js';
import { definirFuso } from './util.js';
import { BarraLateral } from './componentes/BarraLateral.js';
import { Cabecalho } from './componentes/Cabecalho.js';
import { Toast } from './componentes/Toast.js';
import type { Tela } from './navegacao.js';
import { PainelDoDia } from './telas/PainelDoDia.js';
import { DetalheExecucao } from './telas/DetalheExecucao.js';
import { Linhagem } from './telas/Linhagem.js';
import { InventarioSftp } from './telas/InventarioSftp.js';
import { Qualidade } from './telas/Qualidade.js';
import { Alertas } from './telas/Alertas.js';
import { Precos } from './telas/Precos.js';
import { Configuracao } from './telas/Configuracao.js';

export function App() {
  const [tela, setTela] = useState<Tela>('hoje');
  const [execucaoAberta, setExecucaoAberta] = useState<number | null>(null);
  const { toast, avisar } = useToast();
  const [densidade, setDensidade] = usePreferencia('densidade', 'confortavel');

  // A densidade vira um atributo no <html>, de onde o CSS lê o padding.
  useEffect(() => {
    document.documentElement.dataset.densidade = densidade;
  }, [densidade]);

  const status = useRecurso<StatusResposta>(() => api.status(), [], 20_000);
  const incidentes = useRecurso(() => api.incidentes(), [], 30_000);

  // Todas as telas mostram os horários no fuso do agendamento, não no do
  // navegador: é nesse fuso que a operação raciocina.
  //
  // A definição acontece durante o render, e não num efeito, de propósito: os
  // efeitos rodam depois que os filhos já renderizaram, e o primeiro render com
  // dados sairia formatado no fuso do navegador. É uma atribuição idempotente,
  // derivada só do que veio do servidor.
  definirFuso(status.dados?.agendamento.timezone);

  const recarregarTudo = useCallback(() => {
    status.recarregar();
    incidentes.recarregar();
  }, [status, incidentes]);

  const abrirExecucao = useCallback((id: number) => {
    setExecucaoAberta(id);
    setTela('exec');
  }, []);

  const irPara = useCallback((t: Tela) => {
    // Entrar por "Execução passo a passo" pelo menu mostra a mais recente.
    if (t === 'exec') setExecucaoAberta(null);
    setTela(t);
  }, []);

  const coletarAgora = async () => {
    try {
      const r = await api.coletaManual();
      avisar(r.mensagem);
      setTela('hoje');
      recarregarTudo();
    } catch (erro) {
      avisar(erro instanceof Error ? erro.message : String(erro), true);
    }
  };

  const alternarAgendamento = async () => {
    try {
      const pausado = status.dados?.agendamento.pausado ?? false;
      const r = pausado ? await api.retomar() : await api.pausar();
      avisar(r.mensagem);
      status.recarregar();
    } catch (erro) {
      avisar(erro instanceof Error ? erro.message : String(erro), true);
    }
  };

  const abertos = incidentes.dados?.abertos ?? 0;

  return (
    <div className="app">
      <BarraLateral
        tela={tela}
        irPara={irPara}
        status={status.dados}
        incidentesAbertos={abertos}
      />

      <main className="principal">
        <Cabecalho
          status={status.dados}
          densidade={densidade}
          alternarDensidade={() =>
            setDensidade(densidade === 'compacta' ? 'confortavel' : 'compacta')
          }
          aoAlternarAgendamento={alternarAgendamento}
          aoColetar={coletarAgora}
          ocupado={false}
        />

        <div className="conteudo">
          {tela === 'hoje' && <PainelDoDia aoAbrirExecucao={abrirExecucao} />}

          {tela === 'exec' && (
            <DetalheExecucao
              id={execucaoAberta}
              aoVoltar={() => setTela('hoje')}
              aoAvisar={avisar}
              aoRecarregarStatus={recarregarTudo}
            />
          )}

          {tela === 'linhagem' && <Linhagem aoAbrirExecucao={abrirExecucao} />}

          {tela === 'arquivos' && (
            <InventarioSftp
              aoAvisar={avisar}
              aoRecarregarStatus={recarregarTudo}
            />
          )}

          {tela === 'qualidade' && <Qualidade />}

          {tela === 'alertas' && (
            <Alertas aoAvisar={avisar} aoRecarregarStatus={recarregarTudo} />
          )}

          {tela === 'precos' && (
            <Precos aoAbrirExecucao={abrirExecucao} aoAvisar={avisar} />
          )}

          {tela === 'config' && <Configuracao />}
        </div>
      </main>

      <Toast aviso={toast} />
    </div>
  );
}
