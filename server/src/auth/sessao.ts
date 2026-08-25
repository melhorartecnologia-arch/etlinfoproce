import crypto from 'node:crypto';
import { config } from '../config.js';
import { consultar, consultarUm, pool } from '../db/pool.js';
import type { Papel, UsuarioSessao } from '@infoprice/shared';

export const COOKIE_SESSAO = 'console_sessao';

/** O token vai para o cookie; só o hash é gravado. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface SessaoCriada {
  token: string;
  expiraEm: Date;
}

export async function criarSessao(
  idUsuario: number,
  ip: string | undefined,
  agente: string | undefined,
): Promise<SessaoCriada> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiraEm = new Date(
    Date.now() + config.auth.duracaoSessaoHoras * 3_600_000,
  );

  await pool.query(
    `INSERT INTO infoprice.ctl_sessao
       (token_hash, id_usuario, expira_em, ip, agente)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), idUsuario, expiraEm, ip ?? null, agente?.slice(0, 300) ?? null],
  );

  return { token, expiraEm };
}

/**
 * Resolve o token numa sessão válida.
 *
 * Devolve null se a sessão não existe, expirou, foi encerrada, ou se o usuário
 * foi desativado — a checagem de `ativo` no mesmo SELECT é o que faz desativar
 * alguém derrubar o acesso na hora, sem esperar a sessão vencer.
 */
export async function validarSessao(
  token: string,
): Promise<(UsuarioSessao & { idSessao: number }) | null> {
  const linha = await consultarUm<{
    idSessao: number;
    id: number;
    login: string;
    nome: string;
    email: string | null;
    papel: Papel;
    trocarSenha: boolean;
  }>(
    `SELECT s.id            AS "idSessao",
            u.id,
            u.login,
            u.nome,
            u.email,
            u.papel,
            u.trocar_senha  AS "trocarSenha"
       FROM infoprice.ctl_sessao s
       JOIN infoprice.ctl_usuario u ON u.id = s.id_usuario
      WHERE s.token_hash = $1
        AND s.encerrada_em IS NULL
        AND s.expira_em > now()
        AND u.ativo`,
    [hashToken(token)],
  );

  if (!linha) return null;

  // Marca o uso sem bloquear a resposta: é telemetria, não parte do fluxo.
  void pool
    .query(
      'UPDATE infoprice.ctl_sessao SET ultimo_uso = now() WHERE id = $1',
      [linha.idSessao],
    )
    .catch(() => undefined);

  return linha;
}

export async function encerrarSessao(
  token: string,
  motivo = 'logout',
): Promise<void> {
  await pool.query(
    `UPDATE infoprice.ctl_sessao
        SET encerrada_em = now(), motivo_fim = $2
      WHERE token_hash = $1 AND encerrada_em IS NULL`,
    [hashToken(token), motivo],
  );
}

/** Derruba todas as sessões de um usuário — usado ao trocar senha ou desativar. */
export async function encerrarSessoesDoUsuario(
  idUsuario: number,
  motivo: string,
): Promise<number> {
  const r = await pool.query(
    `UPDATE infoprice.ctl_sessao
        SET encerrada_em = now(), motivo_fim = $2
      WHERE id_usuario = $1 AND encerrada_em IS NULL`,
    [idUsuario, motivo],
  );
  return r.rowCount ?? 0;
}

/** Remove sessões vencidas há mais de 30 dias. */
export async function limparSessoesAntigas(): Promise<number> {
  const r = await pool.query(
    `DELETE FROM infoprice.ctl_sessao
      WHERE expira_em < now() - INTERVAL '30 days'`,
  );
  return r.rowCount ?? 0;
}

// ── Tentativas de login ─────────────────────────────────────────────────────

export async function registrarTentativa(
  login: string,
  ip: string | undefined,
  sucesso: boolean,
  motivo?: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO infoprice.ctl_tentativa_login (login, ip, sucesso, motivo)
     VALUES ($1, $2, $3, $4)`,
    [login.slice(0, 120), ip ?? null, sucesso, motivo ?? null],
  );
}

export interface Bloqueio {
  bloqueado: boolean;
  faltamSegundos?: number;
}

/**
 * Trava por login e por IP.
 *
 * Contar só por login deixaria alguém varrer muitos usuários a partir de um IP;
 * contar só por IP puniria todo mundo atrás do mesmo NAT corporativo. As duas
 * contagens juntas cobrem os dois casos.
 */
export async function verificarBloqueio(
  login: string,
  ip: string | undefined,
): Promise<Bloqueio> {
  const janela = `${config.auth.janelaTentativasMin} minutes`;

  const porLogin = await consultarUm<{ falhas: number; ultima: string | null }>(
    `SELECT count(*)::int AS falhas, max(ocorrida_em)::text AS ultima
       FROM infoprice.ctl_tentativa_login
      WHERE lower(login) = lower($1)
        AND NOT sucesso
        AND ocorrida_em > now() - $2::interval`,
    [login, janela],
  );

  const porIp = ip
    ? await consultarUm<{ falhas: number; ultima: string | null }>(
        `SELECT count(*)::int AS falhas, max(ocorrida_em)::text AS ultima
           FROM infoprice.ctl_tentativa_login
          WHERE ip = $1
            AND NOT sucesso
            AND ocorrida_em > now() - $2::interval`,
        [ip, janela],
      )
    : null;

  const limiteLogin = config.auth.maxTentativas;
  // O limite por IP é mais folgado: um escritório inteiro sai pelo mesmo IP.
  const limiteIp = config.auth.maxTentativas * 4;

  const estourou =
    (porLogin?.falhas ?? 0) >= limiteLogin ||
    (porIp?.falhas ?? 0) >= limiteIp;

  if (!estourou) return { bloqueado: false };

  const ultima = porLogin?.ultima ?? porIp?.ultima;
  const liberaEm = ultima
    ? new Date(ultima).getTime() + config.auth.janelaTentativasMin * 60_000
    : Date.now();

  return {
    bloqueado: true,
    faltamSegundos: Math.max(1, Math.ceil((liberaEm - Date.now()) / 1000)),
  };
}

/** Sessões ativas de um usuário, para a tela de gestão. */
export async function sessoesAtivas(idUsuario: number) {
  return consultar<{
    id: number;
    criadaEm: string;
    ultimoUso: string;
    expiraEm: string;
    ip: string | null;
  }>(
    `SELECT id,
            criada_em  AS "criadaEm",
            ultimo_uso AS "ultimoUso",
            expira_em  AS "expiraEm",
            ip
       FROM infoprice.ctl_sessao
      WHERE id_usuario = $1 AND encerrada_em IS NULL AND expira_em > now()
      ORDER BY ultimo_uso DESC`,
    [idUsuario],
  );
}
