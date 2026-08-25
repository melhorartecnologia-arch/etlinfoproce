import { useState, type FormEvent } from 'react';
import type { UsuarioSessao } from '@infoprice/shared';
import { api } from '../api.js';

export function Login({
  aoEntrar,
}: {
  aoEntrar: (usuario: UsuarioSessao) => void;
}) {
  const [login, setLogin] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    if (enviando) return;

    setEnviando(true);
    setErro(null);
    try {
      const r = await api.entrar(login.trim(), senha);
      aoEntrar(r.usuario);
    } catch (e2) {
      setErro(e2 instanceof Error ? e2.message : String(e2));
      setSenha('');
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="login">
      <form className="login__cartao" onSubmit={submeter}>
        <div className="login__marca">
          <span className="barra__produto">infoprice · isa infopanel</span>
          <span className="login__titulo">Console de Ingestão</span>
        </div>

        <p className="login__intro">
          Entre para acompanhar a coleta diária e a rastreabilidade dos dados.
        </p>

        <label className="campo login__campo">
          login
          <input
            type="text"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label className="campo login__campo">
          senha
          <input
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>

        {erro && (
          <div className="login__erro" role="alert">
            {erro}
          </div>
        )}

        <button
          className="botao botao--primario login__botao"
          type="submit"
          disabled={enviando || !login.trim() || !senha}
        >
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>

        <p className="login__rodape">
          Sem acesso? Procure um administrador do console.
        </p>
      </form>
    </div>
  );
}

/**
 * Troca obrigatória da senha provisória.
 *
 * Aparece no lugar do console: enquanto a senha definida por um administrador
 * continuar valendo, ela é conhecida por duas pessoas, e o servidor recusa
 * qualquer ação de operação.
 */
export function TrocaObrigatoria({
  usuario,
  aoTrocar,
  aoSair,
}: {
  usuario: UsuarioSessao;
  aoTrocar: () => void;
  aoSair: () => void;
}) {
  const [senhaAtual, setSenhaAtual] = useState('');
  const [senhaNova, setSenhaNova] = useState('');
  const [confirma, setConfirma] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    if (enviando) return;

    if (senhaNova !== confirma) {
      setErro('A confirmação não confere com a senha nova.');
      return;
    }

    setEnviando(true);
    setErro(null);
    try {
      await api.trocarSenha(senhaAtual, senhaNova);
      aoTrocar();
    } catch (e2) {
      setErro(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="login">
      <form className="login__cartao" onSubmit={submeter}>
        <div className="login__marca">
          <span className="barra__produto">primeiro acesso</span>
          <span className="login__titulo">Defina a sua senha</span>
        </div>

        <p className="login__intro">
          Olá, {usuario.nome.split(' ')[0]}. A senha atual foi definida por um
          administrador e precisa ser trocada antes de você operar o console.
        </p>

        <label className="campo login__campo">
          senha provisória
          <input
            type="password"
            value={senhaAtual}
            onChange={(e) => setSenhaAtual(e.target.value)}
            autoComplete="current-password"
            autoFocus
            required
          />
        </label>

        <label className="campo login__campo">
          senha nova
          <input
            type="password"
            value={senhaNova}
            onChange={(e) => setSenhaNova(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>

        <label className="campo login__campo">
          repita a senha nova
          <input
            type="password"
            value={confirma}
            onChange={(e) => setConfirma(e.target.value)}
            autoComplete="new-password"
            required
          />
        </label>

        <p className="login__dica">
          Ao menos 10 caracteres, misturando letras e números.
        </p>

        {erro && (
          <div className="login__erro" role="alert">
            {erro}
          </div>
        )}

        <button
          className="botao botao--primario login__botao"
          type="submit"
          disabled={enviando}
        >
          {enviando ? 'Salvando…' : 'Salvar e entrar'}
        </button>

        <button type="button" className="botao--texto login__sair" onClick={aoSair}>
          sair
        </button>
      </form>
    </div>
  );
}
