import type { ReactNode } from 'react';
import type { Tom } from '../util.js';

export function Pilula({
  tom,
  children,
}: {
  tom: Tom;
  children: ReactNode;
}) {
  return <span className={`pilula pilula--${tom}`}>{children}</span>;
}

export function TituloTela({
  titulo,
  descricao,
  acoes,
  voltar,
}: {
  titulo: ReactNode;
  descricao?: ReactNode;
  acoes?: ReactNode;
  voltar?: { rotulo: string; aoClicar: () => void };
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 20,
        flexWrap: 'wrap',
      }}
    >
      <div className="titulo-tela">
        {voltar && (
          <button className="botao--texto" onClick={voltar.aoClicar}>
            ← {voltar.rotulo}
          </button>
        )}
        <h1>{titulo}</h1>
        {descricao && <p>{descricao}</p>}
      </div>
      {acoes && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>{acoes}</div>
      )}
    </div>
  );
}

export function Kpi({
  rotulo,
  valor,
  nota,
  cor,
}: {
  rotulo: string;
  valor: ReactNode;
  nota?: ReactNode;
  cor?: string;
}) {
  return (
    <div className="kpi">
      <span className="kpi__rotulo">{rotulo}</span>
      <span className="kpi__valor" style={cor ? { color: cor } : undefined}>
        {valor}
      </span>
      {nota && <span className="kpi__nota">{nota}</span>}
    </div>
  );
}

export function MiniCartao({
  rotulo,
  valor,
  nota,
  cor,
}: {
  rotulo: string;
  valor: ReactNode;
  nota?: ReactNode;
  cor?: string;
}) {
  return (
    <div className="mini-cartao">
      <span className="mini-cartao__rotulo">{rotulo}</span>
      <span
        className="mini-cartao__valor"
        style={cor ? { color: cor } : undefined}
      >
        {valor}
      </span>
      {nota && <span className="mini-cartao__nota">{nota}</span>}
    </div>
  );
}

export function Aviso({
  tag,
  tom,
  children,
}: {
  tag: string;
  tom: 'ok' | 'atencao' | 'erro' | 'info';
  children: ReactNode;
}) {
  return (
    <div className={`aviso aviso--${tom}`}>
      <span className="aviso__tag">{tag}</span>
      <p>{children}</p>
    </div>
  );
}

export function Par({ chave, valor }: { chave: string; valor: ReactNode }) {
  return (
    <div className="par">
      <span className="par__chave">{chave}</span>
      <span className="par__valor">{valor}</span>
    </div>
  );
}

/** Caixa de tabela com cabeçalho e rolagem horizontal. */
export function Painel({
  titulo,
  nota,
  acao,
  children,
}: {
  titulo?: ReactNode;
  nota?: ReactNode;
  acao?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="tabela-caixa">
      {(titulo || nota || acao) && (
        <div className="cartao__cabecalho">
          {titulo ? <h2>{titulo}</h2> : <span />}
          {acao ?? (nota && <span className="cartao__nota">{nota}</span>)}
        </div>
      )}
      <div className="tabela-rolagem">{children}</div>
    </div>
  );
}

export function Carregando({ texto = 'carregando…' }: { texto?: string }) {
  return (
    <div className="carregando">
      <span className="girando" />
      <span>{texto}</span>
    </div>
  );
}

export function CaixaErro({
  erro,
  aoTentar,
}: {
  erro: string;
  aoTentar?: () => void;
}) {
  return (
    <div className="erro-caixa">
      <strong>Não foi possível carregar</strong>
      <span>{erro}</span>
      {aoTentar && (
        <button className="botao" onClick={aoTentar}>
          Tentar de novo
        </button>
      )}
    </div>
  );
}

export function Vazio({ children }: { children: ReactNode }) {
  return <div className="vazio">{children}</div>;
}
