import type { StatusResposta } from '@infoprice/shared';
import type { Tela } from '../navegacao.js';
import { GRUPOS_NAV } from '../navegacao.js';

export function BarraLateral({
  tela,
  irPara,
  status,
  incidentesAbertos,
}: {
  tela: Tela;
  irPara: (t: Tela) => void;
  status: StatusResposta | null;
  incidentesAbertos: number;
}) {
  const conectado = status?.sftp.conectado ?? false;

  return (
    <aside className="barra">
      <div className="barra__marca">
        <span className="barra__produto">infoprice · isa infopanel</span>
        <span className="barra__titulo">Console de Ingestão</span>
      </div>

      <nav className="barra__nav">
        {GRUPOS_NAV.map((grupo) => (
          <div className="barra__grupo" key={grupo.titulo}>
            <span className="barra__grupo-titulo">{grupo.titulo}</span>
            {grupo.itens.map((item) => {
              const ativo = item.tela === tela;
              const contador =
                item.tela === 'alertas' && incidentesAbertos > 0
                  ? incidentesAbertos
                  : null;

              return (
                <button
                  key={item.tela}
                  className={`barra__item${ativo ? ' barra__item--ativo' : ''}`}
                  onClick={() => irPara(item.tela)}
                  aria-current={ativo ? 'page' : undefined}
                >
                  <span className="barra__ponto" />
                  <span className="barra__rotulo">{item.rotulo}</span>
                  {contador !== null && (
                    <span className="barra__contador">{contador}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="barra__rodape">
        <div className="barra__conexao">
          <span className={`barra__pulso${conectado ? '' : ' barra__pulso--off'}`} />
          <span>{conectado ? 'Conexão SFTP ativa' : 'Sem leitura recente'}</span>
        </div>
        <div className="barra__credencial">
          {status?.sftp.host ?? '—'}
          <br />
          usuário {status?.sftp.usuario ?? '—'}
          <br />
          {status?.sftp.chave ?? '—'}
        </div>
      </div>
    </aside>
  );
}
