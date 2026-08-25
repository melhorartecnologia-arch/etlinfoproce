import type { NextFunction, Request, Response } from 'express';
import { papelAtende, type Papel, type UsuarioSessao } from '@infoprice/shared';
import { COOKIE_SESSAO, validarSessao } from './sessao.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Preenchido por `exigirAutenticacao`. */
      usuario?: UsuarioSessao & { idSessao: number };
      /** O token cru da sessão, para o logout poder encerrá-la. */
      tokenSessao?: string;
    }
  }
}

/** Lê o cookie de sessão sem depender de cookie-parser. */
export function lerCookie(req: Request, nome: string): string | undefined {
  const cru = req.headers.cookie;
  if (!cru) return undefined;

  for (const parte of cru.split(';')) {
    const sep = parte.indexOf('=');
    if (sep === -1) continue;
    if (parte.slice(0, sep).trim() === nome) {
      return decodeURIComponent(parte.slice(sep + 1).trim());
    }
  }
  return undefined;
}

/** IP do cliente, respeitando o proxy reverso quando houver. */
export function ipDoCliente(req: Request): string | undefined {
  const encaminhado = req.headers['x-forwarded-for'];
  if (typeof encaminhado === 'string' && encaminhado.length > 0) {
    return encaminhado.split(',')[0]!.trim();
  }
  return req.socket.remoteAddress ?? undefined;
}

/**
 * Exige sessão válida. Sem ela, 401 — a tela leva de volta ao login.
 */
export async function exigirAutenticacao(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = lerCookie(req, COOKIE_SESSAO);
  if (!token) {
    res.status(401).json({ erro: 'não autenticado' });
    return;
  }

  const usuario = await validarSessao(token);
  if (!usuario) {
    res.status(401).json({ erro: 'sessão inválida ou expirada' });
    return;
  }

  req.usuario = usuario;
  req.tokenSessao = token;
  next();
}

/**
 * Exige um papel mínimo. Precisa vir depois de `exigirAutenticacao`.
 *
 * Um usuário que ainda precisa trocar a senha fica limitado à leitura: ele
 * consegue entrar e ver o console, mas não dispara nada enquanto a senha
 * provisória continuar valendo.
 */
export function exigirPapel(minimo: Papel) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const usuario = req.usuario;
    if (!usuario) {
      res.status(401).json({ erro: 'não autenticado' });
      return;
    }

    if (usuario.trocarSenha && minimo !== 'leitor') {
      res.status(403).json({
        erro: 'troque a senha provisória antes de executar ações',
        codigo: 'trocar_senha',
      });
      return;
    }

    if (!papelAtende(usuario.papel, minimo)) {
      res.status(403).json({
        erro: `esta ação exige o papel ${minimo}; o seu é ${usuario.papel}`,
      });
      return;
    }

    next();
  };
}

/** Atalhos legíveis nas rotas. */
export const exigirOperador = exigirPapel('operador');
export const exigirAdministrador = exigirPapel('administrador');
