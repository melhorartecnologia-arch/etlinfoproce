import { Router, type Request, type Response } from 'express';
import type {
  ResumoBaseResposta,
  ZerarBasePedido,
  ZerarBaseResposta,
} from '@infoprice/shared';
import { config } from '../config.js';
import { consultarUm } from '../db/pool.js';
import { conferirSenha } from '../auth/senha.js';
import { exigirAdministrador, exigirAutenticacao } from '../auth/middleware.js';
import { coletaEmAndamento, comTrilho } from '../agendador/index.js';
import {
  FRASE_CONFIRMACAO,
  contarBase,
  existeColetaEmAndamento,
  ultimoReset,
  zerarBase,
} from '../admin/reset.js';
import { numeroBR } from '../util/formato.js';

/**
 * Montado em /api/admin pelo main.ts. Como em rotas-usuarios, o middleware
 * vale só para este router.
 */
export const rotasAdmin = Router();

rotasAdmin.use(exigirAutenticacao, exigirAdministrador);

function rota(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: (e?: unknown) => void) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** O que existe hoje na base: é o que a tela mostra antes de zerar. */
rotasAdmin.get(
  '/base',
  rota(async (_req, res) => {
    const r: ResumoBaseResposta = {
      contagens: await contarBase(),
      areaTemporaria: config.coleta.areaTemporaria,
      frase: FRASE_CONFIRMACAO,
      coletaEmAndamento: coletaEmAndamento() || (await existeColetaEmAndamento()),
      ultimoReset: await ultimoReset(),
    };
    res.json(r);
  }),
);

/**
 * Zera todo o histórico. Exige a frase digitada e a senha de quem pede: uma
 * sessão esquecida aberta não basta para apagar a base. Usuários ficam — pela
 * tela, apagá-los trancaria o próprio administrador do lado de fora; isso só
 * existe no comando de terminal.
 */
rotasAdmin.post(
  '/base/zerar',
  rota(async (req, res) => {
    const pedido = (req.body ?? {}) as Partial<ZerarBasePedido>;
    const usuario = req.usuario!;

    if (pedido.confirmacao !== FRASE_CONFIRMACAO) {
      res.status(400).json({ erro: `digite exatamente "${FRASE_CONFIRMACAO}" para confirmar` });
      return;
    }

    const linha = await consultarUm<{ senha_hash: string }>(
      'SELECT senha_hash FROM infoprice.ctl_usuario WHERE id = $1',
      [usuario.id],
    );
    if (!linha || !(await conferirSenha(String(pedido.senha ?? ''), linha.senha_hash))) {
      res.status(403).json({ erro: 'senha incorreta' });
      return;
    }

    // Pelo trilho das coletas: enquanto o reset roda, nem o agendador nem a
    // tela conseguem disparar uma coleta, e uma coleta em curso o recusa.
    const r = await comTrilho(() =>
      zerarBase({
        executadoPor: usuario.login,
        origem: 'console',
        incluirUsuarios: false,
        apagarArquivos: pedido.apagarArquivos === true,
      }),
    );
    console.warn(
      `[admin] base zerada por ${usuario.login} · ${r.apagado.execucoes} execuções · ` +
        `${r.apagado.arquivos} arquivos · ~${r.apagado.precos} preços` +
        (pedido.apagarArquivos ? ` · ${r.arquivosRemovidos} itens da área temporária` : ''),
    );

    const resposta: ZerarBaseResposta = {
      ok: true,
      mensagem:
        `Base zerada · ${numeroBR(r.apagado.execucoes)} execuções, ` +
        `${numeroBR(r.apagado.arquivos)} arquivos e ~${numeroBR(r.apagado.precos)} preços apagados`,
      apagado: r.apagado,
      arquivosRemovidos: r.arquivosRemovidos,
    };
    res.json(resposta);
  }),
);
