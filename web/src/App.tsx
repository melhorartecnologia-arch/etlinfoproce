import { useCallback, useEffect, useState } from 'react';
import {
  papelAtende,
  type StatusResposta,
  type UsuarioSessao,
} from '@infoprice/shared';
import { api } from './api.js';
import { useRecurso, usePreferencia, useToast } from './hooks.js';
import { definirFuso } from './util.js';
import { BarraLateral } from './componentes/BarraLateral.js';
import { Cabecalho } from './componentes/Cabecalho.js';
import { Toast } from './componentes/Toast.js';
import { Carregando } from './componentes/base.js';
import type { Tela } from './navegacao.js';
import { Login, TrocaObrigatoria } from './telas/Login.js';
import { PainelDoDia } from './telas/PainelDoDia.js';
import { DetalheExecucao } from './telas/DetalheExecucao.js';
import { Linhagem } from './telas/Linhagem.js';
import { InventarioSftp } from './telas/InventarioSftp.js';
import { Qualidade } from './telas/Qualidade.js';
import { Alertas } from './telas/Alertas.js';
import { Precos } from './telas/Precos.js';
import { Configuracao } from './telas/Configuracao.js';
import { Usuarios } from './telas/Usuarios.js';

export function App() {
  const [usuario, setUsuario] = useState<UsuarioSessao | null>(null);
  const [verificandoSessao, setVerificandoSessao] = useState(true);

  // Ao abrir, pergunta ao servidor se já existe sessão válida — assim recarregar
  // a página não obriga a entrar de novo.
  useEffect(() => {
    let ativo = true;
    api
      .sessao()
      .then((r) => {
        if (ativo) setUsuario(r.usuario);
      })
      .catch(() => {
        if (ativo) setUsuario(null);
      })
      .finally(() => {
        if (ativo) setVerificandoSessao(false);
      });
    return () => {
      ativo = false;
    };
  }, []);

  if (verificandoSessao) {
    return (
      <div className="login">
        <Carregando texto="verificando sessão…" />
      </div>
    );
  }

  if (!usuario) {
    return <Login aoEntrar={setUsuario} />;
  }

  if (usuario.trocarSenha) {
    return (
      <TrocaObrigatoria
        usuario={usuario}
        aoTrocar={() => setUsuario({ ...usuario, trocarSenha: false })}
        aoSair={() => {
          void api.sair().catch(() => undefined);
          setUsuario(null);
        }}
      />
    );
  }

  // `key` remonta o console inteiro ao trocar de usuário, descartando qualquer
  // dado carregado sob a sessão anterior.
  return (
    <Console
      key={usuario.id}
      usuario={usuario}
      aoSair={() => setUsuario(null)}
    />
  );
}

function Console({
  usuario,
  aoSair,
}: {
  usuario: UsuarioSessao;
  aoSair: () => void;
}) {
  const [tela, setTela] = useState<Tela>('hoje');
  const [execucaoAberta, setExecucaoAberta] = useState<number | null>(null);
  const { toast, avisar } = useToast();
  const [densidade, setDensidade] = usePreferencia('densidade', 'confortavel');

  const podeOperar = papelAtende(usuario.papel, 'operador');
  const podeAdministrar = papelAtende(usuario.papel, 'administrador');

  useEffect(() => {
    document.documentElement.dataset.densidade = densidade;
  }, [densidade]);

  const status = useRecurso<StatusResposta>(() => api.status(), [], 20_000);
  const incidentes = useRecurso(() => api.incidentes(), [], 30_000);

  // Todas as telas mostram os horários no fuso do agendamento, não no do
  // navegador. Definido durante o render para que o primeiro já saia certo.
  definirFuso(status.dados?.agendamento.timezone);

  // A sessão pode expirar ou ser encerrada por um administrador enquanto a tela
  // está aberta; nesse caso o console volta ao login em vez de ficar mostrando
  // erros a cada atualização.
  useEffect(() => {
    if (status.erro?.includes('sessão') || status.erro?.includes('autenticado')) {
      aoSair();
    }
  }, [status.erro, aoSair]);

  const recarregarTudo = useCallback(() => {
    status.recarregar();
    incidentes.recarregar();
  }, [status, incidentes]);

  const abrirExecucao = useCallback((id: number) => {
    setExecucaoAberta(id);
    setTela('exec');
  }, []);

  const irPara = useCallback((t: Tela) => {
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
        podeAdministrar={podeAdministrar}
      />

      <main className="principal">
        <Cabecalho
          status={status.dados}
          usuario={usuario}
          podeOperar={podeOperar}
          densidade={densidade}
          alternarDensidade={() =>
            setDensidade(densidade === 'compacta' ? 'confortavel' : 'compacta')
          }
          aoAlternarAgendamento={alternarAgendamento}
          aoColetar={coletarAgora}
          aoSair={aoSair}
          aoAvisar={avisar}
        />

        <div className="conteudo">
          {tela === 'hoje' && <PainelDoDia aoAbrirExecucao={abrirExecucao} />}

          {tela === 'exec' && (
            <DetalheExecucao
              id={execucaoAberta}
              podeOperar={podeOperar}
              aoVoltar={() => setTela('hoje')}
              aoAvisar={avisar}
              aoRecarregarStatus={recarregarTudo}
            />
          )}

          {tela === 'linhagem' && <Linhagem aoAbrirExecucao={abrirExecucao} />}

          {tela === 'arquivos' && (
            <InventarioSftp
              podeOperar={podeOperar}
              aoAvisar={avisar}
              aoRecarregarStatus={recarregarTudo}
            />
          )}

          {tela === 'qualidade' && <Qualidade />}

          {tela === 'alertas' && (
            <Alertas
              podeOperar={podeOperar}
              aoAvisar={avisar}
              aoRecarregarStatus={recarregarTudo}
            />
          )}

          {tela === 'precos' && (
            <Precos aoAbrirExecucao={abrirExecucao} aoAvisar={avisar} />
          )}

          {tela === 'config' && <Configuracao />}

          {tela === 'usuarios' && podeAdministrar && (
            <Usuarios eu={usuario} aoAvisar={avisar} />
          )}
        </div>
      </main>

      <Toast aviso={toast} />
    </div>
  );
}
