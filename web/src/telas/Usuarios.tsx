import { useState, type FormEvent } from 'react';
import {
  DESCRICAO_PAPEL,
  PAPEIS,
  ROTULO_PAPEL,
  type Papel,
  type Usuario,
  type UsuarioSessao,
} from '@infoprice/shared';
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
import { dataHoraBR } from '../util.js';

const TOM_PAPEL: Record<Papel, 'erro' | 'exec' | 'neutro'> = {
  administrador: 'erro',
  operador: 'exec',
  leitor: 'neutro',
};

export function Usuarios({
  eu,
  aoAvisar,
}: {
  eu: UsuarioSessao;
  aoAvisar: (texto: string, erro?: boolean) => void;
}) {
  const recurso = useRecurso<Usuario[]>(() => api.usuarios(), []);
  const [criando, setCriando] = useState(false);
  const [senhaGerada, setSenhaGerada] = useState<{
    login: string;
    senha: string;
  } | null>(null);

  if (recurso.carregando) return <Carregando />;
  if (recurso.erro) {
    return <CaixaErro erro={recurso.erro} aoTentar={recurso.recarregar} />;
  }

  const usuarios = recurso.dados ?? [];

  const agir = async (fn: () => Promise<unknown>, sucesso?: string) => {
    try {
      await fn();
      if (sucesso) aoAvisar(sucesso);
      recurso.recarregar();
    } catch (erro) {
      aoAvisar(erro instanceof Error ? erro.message : String(erro), true);
    }
  };

  const alternarAtivo = (u: Usuario) =>
    agir(
      () => api.atualizarUsuario(u.id, { ativo: !u.ativo }),
      u.ativo
        ? `${u.login} desativado · sessões encerradas`
        : `${u.login} reativado`,
    );

  const mudarPapel = (u: Usuario, papel: Papel) =>
    agir(
      () => api.atualizarUsuario(u.id, { papel }),
      `${u.login} agora é ${ROTULO_PAPEL[papel].toLowerCase()}`,
    );

  const resetar = async (u: Usuario) => {
    try {
      const r = await api.resetarSenha(u.id);
      setSenhaGerada({ login: u.login, senha: r.senhaProvisoria });
      recurso.recarregar();
    } catch (erro) {
      aoAvisar(erro instanceof Error ? erro.message : String(erro), true);
    }
  };

  return (
    <section className="tela" style={{ gap: 20 }}>
      <TituloTela
        titulo="Usuários do console"
        descricao="Quem entra, com qual papel, e o que cada papel pode fazer."
        acoes={
          <button
            className="botao botao--primario"
            onClick={() => setCriando((v) => !v)}
          >
            {criando ? 'Cancelar' : 'Novo usuário'}
          </button>
        }
      />

      {senhaGerada && (
        <div className="senha-gerada">
          <div>
            <strong>Senha provisória de {senhaGerada.login}</strong>
            <p>
              Entregue por um canal seguro. Ela não será exibida de novo, e a
              troca será exigida no primeiro acesso.
            </p>
          </div>
          <code className="senha-gerada__valor">{senhaGerada.senha}</code>
          <button
            className="botao botao--miudo"
            onClick={() => setSenhaGerada(null)}
          >
            Entendi
          </button>
        </div>
      )}

      {criando && (
        <FormNovoUsuario
          aoCriar={(login, senha) => {
            setCriando(false);
            if (senha) setSenhaGerada({ login, senha });
            recurso.recarregar();
          }}
          aoFalhar={(m) => aoAvisar(m, true)}
        />
      )}

      <Painel titulo={`${usuarios.length} usuários`}>
        {usuarios.length === 0 ? (
          <Vazio>Nenhum usuário cadastrado.</Vazio>
        ) : (
          <table className="tabela">
            <thead>
              <tr>
                <th>login</th>
                <th>nome</th>
                <th>papel</th>
                <th>último acesso</th>
                <th className="num">sessões</th>
                <th>situação</th>
                <th className="num">ações</th>
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => {
                const souEu = u.id === eu.id;
                return (
                  <tr key={u.id} style={u.ativo ? undefined : { opacity: 0.55 }}>
                    <td className="mono-forte">
                      {u.login}
                      {souEu && <span className="marca-eu">você</span>}
                    </td>
                    <td>
                      {u.nome}
                      {u.email && (
                        <div className="mono suave" style={{ fontSize: 11 }}>
                          {u.email}
                        </div>
                      )}
                    </td>
                    <td>
                      <select
                        className="seletor-papel"
                        value={u.papel}
                        disabled={souEu}
                        title={
                          souEu
                            ? 'Você não pode alterar o próprio papel'
                            : DESCRICAO_PAPEL[u.papel]
                        }
                        onChange={(e) => mudarPapel(u, e.target.value as Papel)}
                      >
                        {PAPEIS.map((p) => (
                          <option key={p} value={p}>
                            {ROTULO_PAPEL[p]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="mono suave">
                      {u.ultimoAcesso ? dataHoraBR(u.ultimoAcesso) : 'nunca entrou'}
                    </td>
                    <td className="num mono">{u.sessoesAtivas}</td>
                    <td>
                      {u.trocarSenha ? (
                        <Pilula tom="atencao">Senha provisória</Pilula>
                      ) : u.ativo ? (
                        <Pilula tom={TOM_PAPEL[u.papel]}>Ativo</Pilula>
                      ) : (
                        <Pilula tom="neutro">Desativado</Pilula>
                      )}
                    </td>
                    <td>
                      <div className="acoes">
                        <button
                          className="botao botao--miudo"
                          onClick={() => resetar(u)}
                        >
                          Redefinir senha
                        </button>
                        <button
                          className="botao botao--miudo"
                          disabled={souEu}
                          title={
                            souEu ? 'Você não pode desativar o próprio usuário' : ''
                          }
                          onClick={() => alternarAtivo(u)}
                        >
                          {u.ativo ? 'Desativar' : 'Reativar'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Painel>

      <div className="cartao cartao__corpo">
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>
          O que cada papel pode fazer
        </h2>
        {PAPEIS.map((p) => (
          <div className="par" key={p}>
            <span className="par__chave">
              <Pilula tom={TOM_PAPEL[p]}>{ROTULO_PAPEL[p]}</Pilula>
            </span>
            <span
              className="par__valor"
              style={{ fontFamily: 'var(--fonte)', textAlign: 'right' }}
            >
              {DESCRICAO_PAPEL[p]}
            </span>
          </div>
        ))}
      </div>

      <Tentativas />
    </section>
  );
}

function FormNovoUsuario({
  aoCriar,
  aoFalhar,
}: {
  aoCriar: (login: string, senhaProvisoria?: string) => void;
  aoFalhar: (mensagem: string) => void;
}) {
  const [login, setLogin] = useState('');
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [papel, setPapel] = useState<Papel>('leitor');
  const [enviando, setEnviando] = useState(false);

  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    if (enviando) return;
    setEnviando(true);
    try {
      const r = await api.criarUsuario({
        login: login.trim(),
        nome: nome.trim(),
        email: email.trim() || undefined,
        papel,
      });
      aoCriar(r.usuario.login, r.senhaProvisoria);
      setLogin('');
      setNome('');
      setEmail('');
    } catch (erro) {
      aoFalhar(erro instanceof Error ? erro.message : String(erro));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form className="filtros" onSubmit={submeter}>
      <label className="campo">
        login
        <input
          type="text"
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder="nome.sobrenome"
          required
        />
      </label>
      <label className="campo campo--largo">
        nome completo
        <input
          type="text"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          required
        />
      </label>
      <label className="campo campo--largo">
        e-mail
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="opcional"
        />
      </label>
      <label className="campo">
        papel
        <select value={papel} onChange={(e) => setPapel(e.target.value as Papel)}>
          {PAPEIS.map((p) => (
            <option key={p} value={p}>
              {ROTULO_PAPEL[p]}
            </option>
          ))}
        </select>
      </label>
      <div style={{ flex: 1 }} />
      <button className="botao botao--primario" type="submit" disabled={enviando}>
        {enviando ? 'Criando…' : 'Criar usuário'}
      </button>
    </form>
  );
}

/** Auditoria de acesso: quem tentou entrar, quando, e se conseguiu. */
function Tentativas() {
  const [aberto, setAberto] = useState(false);
  const recurso = useRecurso(
    () => (aberto ? api.tentativasLogin() : Promise.resolve([])),
    [aberto],
  );

  return (
    <Painel
      titulo="Tentativas de acesso"
      acao={
        <button className="botao botao--miudo" onClick={() => setAberto((v) => !v)}>
          {aberto ? 'Ocultar' : 'Mostrar'}
        </button>
      }
    >
      {!aberto ? (
        <Vazio>Registro de quem tentou entrar, com sucesso ou não.</Vazio>
      ) : recurso.carregando ? (
        <Carregando />
      ) : (recurso.dados ?? []).length === 0 ? (
        <Vazio>Nenhuma tentativa registrada.</Vazio>
      ) : (
        <table className="tabela">
          <thead>
            <tr>
              <th>quando</th>
              <th>login</th>
              <th>origem</th>
              <th>resultado</th>
              <th className="num">motivo</th>
            </tr>
          </thead>
          <tbody>
            {(recurso.dados ?? []).map((t) => (
              <tr key={t.id}>
                <td className="mono suave">{dataHoraBR(t.ocorridaEm)}</td>
                <td className="mono">{t.login}</td>
                <td className="mono suave">{t.ip ?? '—'}</td>
                <td>
                  <Pilula tom={t.sucesso ? 'ok' : 'erro'}>
                    {t.sucesso ? 'Entrou' : 'Recusado'}
                  </Pilula>
                </td>
                <td className="num suave" style={{ fontSize: 12 }}>
                  {t.motivo ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Painel>
  );
}
