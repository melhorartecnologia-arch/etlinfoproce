import type { ConfigResposta } from '@infoprice/shared';
import { api } from '../api.js';
import { useRecurso } from '../hooks.js';
import {
  CaixaErro,
  Carregando,
  Par,
  TituloTela,
} from '../componentes/base.js';

export function Configuracao() {
  const recurso = useRecurso<ConfigResposta>(() => api.config(), []);

  if (recurso.carregando) return <Carregando />;
  if (recurso.erro) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }
  if (!recurso.dados) return null;

  const d = recurso.dados;

  return (
    <section className="tela" style={{ gap: 20 }}>
      <TituloTela
        titulo="Conexão, agendamento e destino"
        descricao="Credenciais ficam no cofre de segredos; a aplicação recebe apenas a referência."
      />

      <div className="grade-2">
        {d.blocos.map((b) => (
          <div className="cartao cartao__corpo" key={b.titulo} style={{ gap: 12 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
              {b.titulo}
            </h2>
            {b.linhas.map((l) => (
              <Par key={l.chave} chave={l.chave} valor={l.valor} />
            ))}
          </div>
        ))}
      </div>

      <div className="cartao cartao__corpo">
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          Tabelas de rastreabilidade
        </h2>
        <div className="grade-3">
          {d.tabelas.map((t) => (
            <div
              key={t.nome}
              style={{
                border: '1px solid var(--borda-suave)',
                borderRadius: 8,
                padding: '12px 14px',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--mono)',
                  fontSize: 12,
                  fontWeight: 500,
                }}
              >
                {t.nome}
              </span>
              <span
                style={{
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: 'var(--texto-suave)',
                }}
              >
                {t.descricao}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
