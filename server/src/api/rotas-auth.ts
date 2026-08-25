import { Router, type Request, type Response } from 'express';
import type {
  LoginResposta,
  SessaoResposta,
  UsuarioSessao,
} from '@infoprice/shared';
import { config } from '../config.js';
import { consultarUm, pool } from '../db/pool.js';
import {
  conferirSenha,
  gerarHash,
  validarSenha,
} from '../auth/senha.js';
import {
  COOKIE_SESSAO,
  criarSessao,
  encerrarSessao,
  encerrarSessoesDoUsuario,
  registrarTentativa,
  validarSessao,
  verificarBloqueio,
} from '../auth/sessao.js';
import {
  exigirAutenticacao,
  ipDoCliente,
  lerCookie,
} from '../auth/middleware.js';

export const rotasAuth = Router();

/**
 * Hash descartável, bem formado, usado quando o login não existe.
 *
 * Precisa passar pelo scrypt de verdade: se `conferirSenha` recusasse o
 * formato de imediato, a resposta para um login inexistente voltaria muito mais
 * rápido que a de um login válido, e essa diferença revelaria quais usuários
 * existem. É calculado uma vez, na subida.
 */
const hashDescartavel = gerarHash(
  `inexistente-${Math.random().toString(36).slice(2)}`,
);

function rota(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: (e?: unknown) => void) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function definirCookie(res: Response, token: string, expiraEm: Date): void {
  const partes = [
    `${COOKIE_SESSAO}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Strict: o console não é acessado a partir de outros sites, e isso corta
    // CSRF na raiz sem precisar de token adicional.
    'SameSite=Strict',
    `Expires=${expiraEm.toUTCString()}`,
  ];
  if (config.auth.cookieSeguro) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

function limparCookie(res: Response): void {
  const partes = [
    `${COOKIE_SESSAO}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (config.auth.cookieSeguro) partes.push('Secure');
  res.setHeader('Set-Cookie', partes.join('; '));
}

function paraSessao(u: {
  id: number;
  login: string;
  nome: string;
  email: string | null;
  papel: UsuarioSessao['papel'];
  trocarSenha: boolean;
}): UsuarioSessao {
  return {
    id: u.id,
    login: u.login,
    nome: u.nome,
    email: u.email,
    papel: u.papel,
    trocarSenha: u.trocarSenha,
  };
}

// ── Login ───────────────────────────────────────────────────────────────────

rotasAuth.post(
  '/sessao',
  rota(async (req, res) => {
    const login = String(req.body?.login ?? '').trim();
    const senha = String(req.body?.senha ?? '');
    const ip = ipDoCliente(req);

    if (!login || !senha) {
      res.status(400).json({ erro: 'informe login e senha' });
      return;
    }

    const bloqueio = await verificarBloqueio(login, ip);
    if (bloqueio.bloqueado) {
      await registrarTentativa(login, ip, false, 'bloqueado');
      const minutos = Math.ceil((bloqueio.faltamSegundos ?? 60) / 60);
      res.status(429).json({
        erro: `Muitas tentativas. Tente de novo em ${minutos} minuto${minutos > 1 ? 's' : ''}.`,
      });
      return;
    }

    const usuario = await consultarUm<{
      id: number;
      login: string;
      nome: string;
      email: string | null;
      papel: UsuarioSessao['papel'];
      senha_hash: string;
      ativo: boolean;
      trocarSenha: boolean;
    }>(
      `SELECT id, login, nome, email, papel, senha_hash, ativo,
              trocar_senha AS "trocarSenha"
         FROM infoprice.ctl_usuario
        WHERE lower(login) = lower($1)`,
      [login],
    );

    // Confere a senha mesmo quando o usuário não existe, contra um hash
    // descartável: sem isso, o tempo de resposta revelaria quais logins existem.
    const hashAlvo = usuario?.senha_hash ?? (await hashDescartavel);
    const senhaConfere = await conferirSenha(senha, hashAlvo);

    if (!usuario || !senhaConfere) {
      await registrarTentativa(
        login,
        ip,
        false,
        usuario ? 'senha incorreta' : 'usuário inexistente',
      );
      // Mensagem única: não dizemos qual dos dois estava errado.
      res.status(401).json({ erro: 'Login ou senha inválidos.' });
      return;
    }

    if (!usuario.ativo) {
      await registrarTentativa(login, ip, false, 'usuário inativo');
      res.status(403).json({
        erro: 'Este usuário está desativado. Procure um administrador.',
      });
      return;
    }

    const sessao = await criarSessao(usuario.id, ip, req.headers['user-agent']);
    await registrarTentativa(login, ip, true);
    await pool.query(
      'UPDATE infoprice.ctl_usuario SET ultimo_acesso = now() WHERE id = $1',
      [usuario.id],
    );

    definirCookie(res, sessao.token, sessao.expiraEm);

    const resposta: LoginResposta = {
      usuario: paraSessao(usuario),
      expiraEm: sessao.expiraEm.toISOString(),
    };
    res.json(resposta);
  }),
);

// ── Quem sou eu ─────────────────────────────────────────────────────────────

/**
 * Não usa `exigirAutenticacao`: a tela chama isto ao abrir, e "ninguém logado"
 * é uma resposta normal aqui, não um erro.
 */
rotasAuth.get(
  '/sessao',
  rota(async (req, res) => {
    const token = lerCookie(req, COOKIE_SESSAO);
    const usuario = token ? await validarSessao(token) : null;

    const resposta: SessaoResposta = {
      usuario: usuario ? paraSessao(usuario) : null,
    };
    res.json(resposta);
  }),
);

// ── Logout ──────────────────────────────────────────────────────────────────

rotasAuth.delete(
  '/sessao',
  rota(async (req, res) => {
    const token = lerCookie(req, COOKIE_SESSAO);
    if (token) await encerrarSessao(token, 'logout');
    limparCookie(res);
    res.json({ ok: true, mensagem: 'Sessão encerrada' });
  }),
);

// ── Troca de senha ──────────────────────────────────────────────────────────

rotasAuth.post(
  '/sessao/senha',
  exigirAutenticacao,
  rota(async (req, res) => {
    const usuario = req.usuario!;
    const senhaAtual = String(req.body?.senhaAtual ?? '');
    const senhaNova = String(req.body?.senhaNova ?? '');

    const atual = await consultarUm<{ senha_hash: string }>(
      'SELECT senha_hash FROM infoprice.ctl_usuario WHERE id = $1',
      [usuario.id],
    );
    if (!atual || !(await conferirSenha(senhaAtual, atual.senha_hash))) {
      res.status(400).json({ erro: 'A senha atual está incorreta.' });
      return;
    }

    const problema = validarSenha(senhaNova, usuario.login);
    if (!problema.ok) {
      res.status(400).json({ erro: problema.erro });
      return;
    }

    if (await conferirSenha(senhaNova, atual.senha_hash)) {
      res.status(400).json({ erro: 'A senha nova precisa ser diferente da atual.' });
      return;
    }

    await pool.query(
      `UPDATE infoprice.ctl_usuario
          SET senha_hash = $2,
              trocar_senha = false,
              senha_alterada_em = now(),
              atualizado_em = now()
        WHERE id = $1`,
      [usuario.id, await gerarHash(senhaNova)],
    );

    // Derruba as outras sessões e reabre a atual: se a senha vazou, quem estava
    // usando ela perde o acesso imediatamente.
    await encerrarSessoesDoUsuario(usuario.id, 'senha alterada');
    const sessao = await criarSessao(
      usuario.id,
      ipDoCliente(req),
      req.headers['user-agent'],
    );
    definirCookie(res, sessao.token, sessao.expiraEm);

    res.json({
      ok: true,
      mensagem: 'Senha alterada. As outras sessões foram encerradas.',
    });
  }),
);
