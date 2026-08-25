import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  senha: string | Buffer,
  sal: string | Buffer,
  tamanho: number,
  opcoes: crypto.ScryptOptions,
) => Promise<Buffer>;

/**
 * Parâmetros do scrypt.
 *
 * N=16384 leva ~100ms por verificação num servidor comum — caro o bastante para
 * inviabilizar força bruta em massa, barato o bastante para o login não pesar.
 * Ficam gravados junto do hash, então subir o custo no futuro não invalida as
 * senhas já cadastradas.
 */
const N = 16_384;
const R = 8;
const P = 1;
const TAMANHO_SAL = 16;
const TAMANHO_HASH = 64;

// scrypt precisa de memória proporcional a 128 * N * r; sem isto o Node recusa
// com "memory limit exceeded".
const MAXMEM = 128 * N * R * 2;

/** Gera o hash no formato scrypt$N$r$p$sal$hash, tudo em base64. */
export async function gerarHash(senha: string): Promise<string> {
  const sal = crypto.randomBytes(TAMANHO_SAL);
  const derivada = await scrypt(senha.normalize('NFKC'), sal, TAMANHO_HASH, {
    N,
    r: R,
    p: P,
    maxmem: MAXMEM,
  });

  return [
    'scrypt',
    N,
    R,
    P,
    sal.toString('base64'),
    derivada.toString('base64'),
  ].join('$');
}

/**
 * Confere a senha contra o hash gravado.
 *
 * A comparação é em tempo constante. Um hash malformado devolve false em vez de
 * lançar: uma linha corrompida no banco não deve virar erro 500 na tela de
 * login, e muito menos deixar alguém entrar.
 */
export async function conferirSenha(
  senha: string,
  hashGravado: string,
): Promise<boolean> {
  try {
    const partes = hashGravado.split('$');
    if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

    const [, nTexto, rTexto, pTexto, salB64, hashB64] = partes;
    const n = Number(nTexto);
    const r = Number(rTexto);
    const p = Number(pTexto);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
      return false;
    }

    const sal = Buffer.from(salB64!, 'base64');
    const esperado = Buffer.from(hashB64!, 'base64');
    if (sal.length === 0 || esperado.length === 0) return false;

    const derivada = await scrypt(senha.normalize('NFKC'), sal, esperado.length, {
      N: n,
      r,
      p,
      maxmem: 128 * n * r * 2,
    });

    return crypto.timingSafeEqual(derivada, esperado);
  } catch {
    return false;
  }
}

export interface ProblemaSenha {
  ok: boolean;
  erro?: string;
}

/**
 * Política mínima de senha.
 *
 * Comprimento é o que mais importa, então o piso é 10 caracteres em vez de
 * exigir símbolos decorativos. As regras extras cobrem os casos óbvios de senha
 * fraca que aparecem em auditoria.
 */
export function validarSenha(senha: string, login?: string): ProblemaSenha {
  if (senha.length < 10) {
    return { ok: false, erro: 'A senha precisa ter ao menos 10 caracteres.' };
  }
  if (senha.length > 200) {
    return { ok: false, erro: 'A senha não pode passar de 200 caracteres.' };
  }
  if (!/[a-zA-Z]/.test(senha) || !/[0-9]/.test(senha)) {
    return {
      ok: false,
      erro: 'A senha precisa misturar letras e números.',
    };
  }
  if (login && senha.toLowerCase().includes(login.toLowerCase())) {
    return { ok: false, erro: 'A senha não pode conter o login.' };
  }

  const comuns = [
    'senha', 'password', '123456', 'infoprice', 'qwerty', 'admin',
    'mudar123', 'trocar123',
  ];
  const minuscula = senha.toLowerCase();
  if (comuns.some((c) => minuscula.includes(c))) {
    return {
      ok: false,
      erro: 'A senha contém uma sequência comum demais. Escolha outra.',
    };
  }

  return { ok: true };
}

/** Senha aleatória legível, para o administrador entregar a um novo usuário. */
export function sugerirSenha(): string {
  // Sem caracteres ambíguos (O/0, l/1) — a senha costuma ser ditada.
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let senha = '';
  for (const b of bytes) senha += alfabeto[b % alfabeto.length];
  // Garante o dígito exigido pela política mesmo num sorteio infeliz.
  return `${senha}7`;
}
