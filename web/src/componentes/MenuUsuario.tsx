import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ROTULO_PAPEL, type UsuarioSessao } from '@infoprice/shared';
import { api } from '../api.js';

/** Iniciais para o avatar: "Bruno Borges Ruiz" → "BR". */
function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/);
  if (partes.length === 0) return '?';
  const primeira = partes[0]![0] ?? '';
  const ultima = partes.length > 1 ? (partes[partes.length - 1]![0] ?? '') : '';
  return (primeira + ultima).toUpperCase();
}

export function MenuUsuario({
  usuario,
  aoSair,
  aoAvisar,
}: {
  usuario: UsuarioSessao;
  aoSair: () => void;
  aoAvisar: (texto: string, erro?: boolean) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [trocando, setTrocando] = useState(false);
  const caixa = useRef<HTMLDivElement>(null);

  // Fecha ao clicar fora ou apertar Esc.
  useEffect(() => {
    if (!aberto) return;

    const clique = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) {
        setAberto(false);
        setTrocando(false);
      }
    };
    const tecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAberto(false);
        setTrocando(false);
      }
    };

    document.addEventListener('mousedown', clique);
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('mousedown', clique);
      document.removeEventListener('keydown', tecla);
    };
  }, [aberto]);

  const sair = async () => {
    try {
      await api.sair();
    } catch {
      // Mesmo que o servidor não responda, a tela volta ao login.
    }
    aoSair();
  };

  return (
    <div className="menu-usuario" ref={caixa}>
      <button
        className="menu-usuario__gatilho"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        title={`${usuario.nome} · ${ROTULO_PAPEL[usuario.papel]}`}
      >
        <span className="menu-usuario__avatar">{iniciais(usuario.nome)}</span>
        <span className="menu-usuario__nome">{usuario.nome.split(' ')[0]}</span>
      </button>

      {aberto && (
        <div className="menu-usuario__caixa">
          <div className="menu-usuario__cabecalho">
            <strong>{usuario.nome}</strong>
            <span className="mono suave">{usuario.login}</span>
            <span className="menu-usuario__papel">
              {ROTULO_PAPEL[usuario.papel]}
            </span>
          </div>

          {trocando ? (
            <FormTrocaSenha
              aoConcluir={(m) => {
                aoAvisar(m);
                setTrocando(false);
                setAberto(false);
              }}
              aoFalhar={(m) => aoAvisar(m, true)}
              aoCancelar={() => setTrocando(false)}
            />
          ) : (
            <div className="menu-usuario__acoes">
              <button className="botao botao--miudo" onClick={() => setTrocando(true)}>
                Trocar senha
              </button>
              <button className="botao botao--miudo" onClick={sair}>
                Sair
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FormTrocaSenha({
  aoConcluir,
  aoFalhar,
  aoCancelar,
}: {
  aoConcluir: (mensagem: string) => void;
  aoFalhar: (mensagem: string) => void;
  aoCancelar: () => void;
}) {
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [confirma, setConfirma] = useState('');
  const [enviando, setEnviando] = useState(false);

  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    if (enviando) return;

    if (nova !== confirma) {
      aoFalhar('A confirmação não confere com a senha nova.');
      return;
    }

    setEnviando(true);
    try {
      const r = await api.trocarSenha(atual, nova);
      aoConcluir(r.mensagem);
    } catch (erro) {
      aoFalhar(erro instanceof Error ? erro.message : String(erro));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form className="menu-usuario__form" onSubmit={submeter}>
      <label className="campo">
        senha atual
        <input
          type="password"
          value={atual}
          onChange={(e) => setAtual(e.target.value)}
          autoComplete="current-password"
          autoFocus
          required
        />
      </label>
      <label className="campo">
        senha nova
        <input
          type="password"
          value={nova}
          onChange={(e) => setNova(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <label className="campo">
        repita
        <input
          type="password"
          value={confirma}
          onChange={(e) => setConfirma(e.target.value)}
          autoComplete="new-password"
          required
        />
      </label>
      <div className="menu-usuario__acoes">
        <button className="botao botao--miudo" type="button" onClick={aoCancelar}>
          Cancelar
        </button>
        <button
          className="botao botao--primario botao--miudo"
          type="submit"
          disabled={enviando}
        >
          {enviando ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </form>
  );
}
