import { Router, type Request, type Response } from 'express';
import {
  PAPEIS,
  type CriarUsuarioResposta,
  type Papel,
  type TentativaLogin,
  type Usuario,
} from '@infoprice/shared';
import { consultar, consultarUm, pool } from '../db/pool.js';
import { gerarHash, sugerirSenha, validarSenha } from '../auth/senha.js';
import { encerrarSessoesDoUsuario } from '../auth/sessao.js';
import { exigirAdministrador, exigirAutenticacao } from '../auth/middleware.js';

/**
 * Montado em /api/usuarios pelo main.ts.
 *
 * O middleware abaixo vale só para as rotas deste router. Se ele fosse
 * registrado num router montado na raiz da API, `use()` sem caminho casaria com
 * todo /api/* e exigiria papel de administrador até para abrir o painel.
 */
export const rotasUsuarios = Router();

rotasUsuarios.use(exigirAutenticacao, exigirAdministrador);

function rota(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: (e?: unknown) => void) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

const CAMPOS = `
  u.id,
  u.login,
  u.nome,
  u.email,
  u.papel,
  u.ativo,
  u.trocar_senha       AS "trocarSenha",
  u.ultimo_acesso      AS "ultimoAcesso",
  u.senha_alterada_em  AS "senhaAlteradaEm",
  u.criado_em          AS "criadoEm",
  c.nome               AS "criadoPor",
  (SELECT count(*)::int FROM infoprice.ctl_sessao s
    WHERE s.id_usuario = u.id AND s.encerrada_em IS NULL AND s.expira_em > now()
  )                    AS "sessoesAtivas"
`;

function papelValido(v: unknown): v is Papel {
  return typeof v === 'string' && (PAPEIS as readonly string[]).includes(v);
}

/** Login: minúsculas, sem espaços, formato previsível. */
function validarLogin(login: string): string | null {
  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(login)) {
    return 'O login deve ter de 3 a 60 caracteres, usando letras, números, ponto, hífen ou sublinhado.';
  }
  return null;
}

// ── Listagem ────────────────────────────────────────────────────────────────

rotasUsuarios.get(
  '/',
  rota(async (_req, res) => {
    const usuarios = await consultar<Usuario>(
      `SELECT ${CAMPOS}
         FROM infoprice.ctl_usuario u
         LEFT JOIN infoprice.ctl_usuario c ON c.id = u.criado_por
        ORDER BY u.ativo DESC, lower(u.nome)`,
    );
    res.json(usuarios);
  }),
);

// ── Criação ─────────────────────────────────────────────────────────────────

rotasUsuarios.post(
  '/',
  rota(async (req, res) => {
    const autor = req.usuario!;
    const login = String(req.body?.login ?? '').trim();
    const nome = String(req.body?.nome ?? '').trim();
    const email = req.body?.email ? String(req.body.email).trim() : null;
    const papel = req.body?.papel;
    const senhaInformada = req.body?.senha
      ? String(req.body.senha)
      : undefined;

    const erroLogin = validarLogin(login);
    if (erroLogin) {
      res.status(400).json({ erro: erroLogin });
      return;
    }
    if (nome.length < 2) {
      res.status(400).json({ erro: 'Informe o nome do usuário.' });
      return;
    }
    if (!papelValido(papel)) {
      res.status(400).json({ erro: 'Papel inválido.' });
      return;
    }

    const jaExiste = await consultarUm(
      'SELECT 1 FROM infoprice.ctl_usuario WHERE lower(login) = lower($1)',
      [login],
    );
    if (jaExiste) {
      res.status(409).json({ erro: `O login "${login}" já está em uso.` });
      return;
    }

    // Sem senha informada, o servidor sorteia uma e obriga a troca no primeiro
    // acesso — assim o administrador nunca fica sabendo a senha definitiva.
    const senha = senhaInformada ?? sugerirSenha();
    const problema = validarSenha(senha, login);
    if (!problema.ok) {
      res.status(400).json({ erro: problema.erro });
      return;
    }

    const criado = await consultarUm<{ id: number }>(
      `INSERT INTO infoprice.ctl_usuario
         (login, nome, email, senha_hash, papel, criado_por, trocar_senha)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id`,
      [login, nome, email, await gerarHash(senha), papel, autor.id],
    );

    const usuario = await consultarUm<Usuario>(
      `SELECT ${CAMPOS}
         FROM infoprice.ctl_usuario u
         LEFT JOIN infoprice.ctl_usuario c ON c.id = u.criado_por
        WHERE u.id = $1`,
      [criado!.id],
    );

    console.log(
      `[usuarios] ${autor.login} criou ${login} com papel ${papel}`,
    );

    const resposta: CriarUsuarioResposta = {
      usuario: usuario!,
      // Só devolvemos a senha quando fomos nós que a sorteamos.
      senhaProvisoria: senhaInformada ? undefined : senha,
    };
    res.status(201).json(resposta);
  }),
);

// ── Edição ──────────────────────────────────────────────────────────────────

rotasUsuarios.patch(
  '/:id',
  rota(async (req, res) => {
    const autor = req.usuario!;
    const id = Number(req.params.id);

    const alvo = await consultarUm<{ id: number; login: string; papel: Papel; ativo: boolean }>(
      'SELECT id, login, papel, ativo FROM infoprice.ctl_usuario WHERE id = $1',
      [id],
    );
    if (!alvo) {
      res.status(404).json({ erro: 'usuário não encontrado' });
      return;
    }

    const campos: string[] = [];
    const valores: unknown[] = [id];

    if (req.body?.nome !== undefined) {
      const nome = String(req.body.nome).trim();
      if (nome.length < 2) {
        res.status(400).json({ erro: 'Informe o nome do usuário.' });
        return;
      }
      valores.push(nome);
      campos.push(`nome = $${valores.length}`);
    }

    if (req.body?.email !== undefined) {
      valores.push(req.body.email ? String(req.body.email).trim() : null);
      campos.push(`email = $${valores.length}`);
    }

    if (req.body?.papel !== undefined) {
      if (!papelValido(req.body.papel)) {
        res.status(400).json({ erro: 'Papel inválido.' });
        return;
      }
      // Rebaixar a si mesmo tira o acesso à própria tela de gestão e pode
      // deixar a instalação sem administrador nenhum.
      if (alvo.id === autor.id && req.body.papel !== 'administrador') {
        res.status(400).json({
          erro: 'Você não pode rebaixar o seu próprio usuário. Peça a outro administrador.',
        });
        return;
      }
      valores.push(req.body.papel);
      campos.push(`papel = $${valores.length}`);
    }

    if (req.body?.ativo !== undefined) {
      const ativo = Boolean(req.body.ativo);
      if (alvo.id === autor.id && !ativo) {
        res.status(400).json({ erro: 'Você não pode desativar o seu próprio usuário.' });
        return;
      }
      valores.push(ativo);
      campos.push(`ativo = $${valores.length}`);
    }

    if (campos.length === 0) {
      res.status(400).json({ erro: 'Nada a alterar.' });
      return;
    }

    // Nunca deixar a instalação sem administrador ativo.
    const viraNaoAdmin =
      (req.body?.papel !== undefined && req.body.papel !== 'administrador') ||
      req.body?.ativo === false;
    if (alvo.papel === 'administrador' && alvo.ativo && viraNaoAdmin) {
      const restantes = await consultarUm<{ total: number }>(
        `SELECT count(*)::int AS total FROM infoprice.ctl_usuario
          WHERE papel = 'administrador' AND ativo AND id <> $1`,
        [alvo.id],
      );
      if ((restantes?.total ?? 0) === 0) {
        res.status(400).json({
          erro: 'Este é o último administrador ativo. Promova outro antes de alterá-lo.',
        });
        return;
      }
    }

    await pool.query(
      `UPDATE infoprice.ctl_usuario
          SET ${campos.join(', ')}, atualizado_em = now()
        WHERE id = $1`,
      valores,
    );

    // Desativar derruba as sessões na hora.
    if (req.body?.ativo === false) {
      const derrubadas = await encerrarSessoesDoUsuario(id, 'usuário desativado');
      console.log(
        `[usuarios] ${autor.login} desativou ${alvo.login} · ${derrubadas} sessões encerradas`,
      );
    }

    const usuario = await consultarUm<Usuario>(
      `SELECT ${CAMPOS}
         FROM infoprice.ctl_usuario u
         LEFT JOIN infoprice.ctl_usuario c ON c.id = u.criado_por
        WHERE u.id = $1`,
      [id],
    );
    res.json(usuario);
  }),
);

// ── Reset de senha ──────────────────────────────────────────────────────────

rotasUsuarios.post(
  '/:id/senha',
  rota(async (req, res) => {
    const autor = req.usuario!;
    const id = Number(req.params.id);

    const alvo = await consultarUm<{ login: string }>(
      'SELECT login FROM infoprice.ctl_usuario WHERE id = $1',
      [id],
    );
    if (!alvo) {
      res.status(404).json({ erro: 'usuário não encontrado' });
      return;
    }

    const senha = sugerirSenha();
    await pool.query(
      `UPDATE infoprice.ctl_usuario
          SET senha_hash = $2,
              trocar_senha = true,
              senha_alterada_em = now(),
              atualizado_em = now()
        WHERE id = $1`,
      [id, await gerarHash(senha)],
    );

    const derrubadas = await encerrarSessoesDoUsuario(id, 'senha redefinida');
    console.log(
      `[usuarios] ${autor.login} redefiniu a senha de ${alvo.login} · ${derrubadas} sessões encerradas`,
    );

    res.json({
      ok: true,
      mensagem: `Senha de ${alvo.login} redefinida. Entregue a senha provisória e peça a troca no primeiro acesso.`,
      senhaProvisoria: senha,
    });
  }),
);

// ── Auditoria de acesso ─────────────────────────────────────────────────────

rotasUsuarios.get(
  '/tentativas',
  rota(async (req, res) => {
    const limite = Math.min(Number(req.query.limite) || 50, 200);
    const tentativas = await consultar<TentativaLogin>(
      `SELECT id, login, ip, sucesso, motivo, ocorrida_em AS "ocorridaEm"
         FROM infoprice.ctl_tentativa_login
        ORDER BY ocorrida_em DESC
        LIMIT $1`,
      [limite],
    );
    res.json(tentativas);
  }),
);
