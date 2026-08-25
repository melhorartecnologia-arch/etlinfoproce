/**
 * Gestão de usuários pela linha de comando.
 *
 * Existe para resolver o problema do primeiro acesso: um console recém-instalado
 * não tem ninguém cadastrado, e criar um "admin/admin" padrão seria deixar a
 * porta aberta em toda instalação. Aqui o administrador inicial nasce com uma
 * senha sorteada, exibida uma única vez.
 *
 * Uso:
 *   npm run usuario --workspace @infoprice/server -- criar --login bruno.ruiz \
 *       --nome "Bruno Ruiz" --papel administrador
 *   npm run usuario --workspace @infoprice/server -- listar
 *   npm run usuario --workspace @infoprice/server -- senha --login bruno.ruiz
 *   npm run usuario --workspace @infoprice/server -- papel --login joana --papel operador
 *   npm run usuario --workspace @infoprice/server -- desativar --login joana
 */
import { PAPEIS, type Papel } from '@infoprice/shared';
import { consultar, consultarUm, fecharPool, pool } from '../db/pool.js';
import { gerarHash, sugerirSenha, validarSenha } from '../auth/senha.js';
import { encerrarSessoesDoUsuario } from '../auth/sessao.js';

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function exigir(nome: string): string {
  const v = arg(nome);
  if (!v) {
    console.error(`[usuario] faltou --${nome}`);
    process.exit(1);
  }
  return v;
}

function papelValido(v: string): v is Papel {
  return (PAPEIS as readonly string[]).includes(v);
}

async function porLogin(login: string) {
  return consultarUm<{ id: number; login: string; nome: string; papel: Papel; ativo: boolean }>(
    'SELECT id, login, nome, papel, ativo FROM infoprice.ctl_usuario WHERE lower(login) = lower($1)',
    [login],
  );
}

async function criar(): Promise<void> {
  const login = exigir('login');
  const nome = exigir('nome');
  const papelBruto = arg('papel') ?? 'operador';
  const email = arg('email') ?? null;
  const senhaInformada = arg('senha');

  if (!papelValido(papelBruto)) {
    console.error(`[usuario] papel inválido: ${papelBruto} (use ${PAPEIS.join(', ')})`);
    process.exit(1);
  }

  if (!/^[a-zA-Z0-9._-]{3,60}$/.test(login)) {
    console.error('[usuario] login deve ter 3 a 60 caracteres: letras, números, . _ -');
    process.exit(1);
  }

  if (await porLogin(login)) {
    console.error(`[usuario] o login "${login}" já existe`);
    process.exit(1);
  }

  const senha = senhaInformada ?? sugerirSenha();
  const problema = validarSenha(senha, login);
  if (!problema.ok) {
    console.error(`[usuario] ${problema.erro}`);
    process.exit(1);
  }

  await pool.query(
    `INSERT INTO infoprice.ctl_usuario
       (login, nome, email, senha_hash, papel, trocar_senha)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      login,
      nome,
      email,
      await gerarHash(senha),
      papelBruto,
      // Senha escolhida por quem vai usar não precisa de troca obrigatória.
      senhaInformada === undefined,
    ],
  );

  console.log('');
  console.log(`  usuário criado: ${login} (${papelBruto})`);
  if (!senhaInformada) {
    console.log(`  senha provisória: ${senha}`);
    console.log('');
    console.log('  Anote agora — ela não será exibida de novo.');
    console.log('  A troca será exigida no primeiro acesso.');
  }
  console.log('');
}

async function listar(): Promise<void> {
  const usuarios = await consultar<{
    login: string;
    nome: string;
    papel: string;
    ativo: boolean;
    ultimo_acesso: string | null;
  }>(
    `SELECT login, nome, papel, ativo, ultimo_acesso
       FROM infoprice.ctl_usuario ORDER BY ativo DESC, lower(nome)`,
  );

  if (usuarios.length === 0) {
    console.log('[usuario] nenhum usuário cadastrado — crie o primeiro com `criar`');
    return;
  }

  console.log('');
  console.log(
    '  ' +
      'LOGIN'.padEnd(22) +
      'NOME'.padEnd(28) +
      'PAPEL'.padEnd(16) +
      'ATIVO'.padEnd(8) +
      'ÚLTIMO ACESSO',
  );
  for (const u of usuarios) {
    console.log(
      '  ' +
        u.login.padEnd(22) +
        u.nome.slice(0, 26).padEnd(28) +
        u.papel.padEnd(16) +
        (u.ativo ? 'sim' : 'não').padEnd(8) +
        (u.ultimo_acesso
          ? new Date(u.ultimo_acesso).toLocaleString('pt-BR')
          : '—'),
    );
  }
  console.log('');
}

async function redefinirSenha(): Promise<void> {
  const login = exigir('login');
  const alvo = await porLogin(login);
  if (!alvo) {
    console.error(`[usuario] "${login}" não existe`);
    process.exit(1);
  }

  const senha = arg('senha') ?? sugerirSenha();
  const problema = validarSenha(senha, login);
  if (!problema.ok) {
    console.error(`[usuario] ${problema.erro}`);
    process.exit(1);
  }

  await pool.query(
    `UPDATE infoprice.ctl_usuario
        SET senha_hash = $2, trocar_senha = $3,
            senha_alterada_em = now(), atualizado_em = now()
      WHERE id = $1`,
    [alvo.id, await gerarHash(senha), arg('senha') === undefined],
  );
  const derrubadas = await encerrarSessoesDoUsuario(alvo.id, 'senha redefinida via CLI');

  console.log('');
  console.log(`  senha de ${login} redefinida · ${derrubadas} sessões encerradas`);
  if (!arg('senha')) console.log(`  senha provisória: ${senha}`);
  console.log('');
}

async function mudarPapel(): Promise<void> {
  const login = exigir('login');
  const papel = exigir('papel');

  if (!papelValido(papel)) {
    console.error(`[usuario] papel inválido: ${papel} (use ${PAPEIS.join(', ')})`);
    process.exit(1);
  }

  const alvo = await porLogin(login);
  if (!alvo) {
    console.error(`[usuario] "${login}" não existe`);
    process.exit(1);
  }

  await pool.query(
    'UPDATE infoprice.ctl_usuario SET papel = $2, atualizado_em = now() WHERE id = $1',
    [alvo.id, papel],
  );
  console.log(`[usuario] ${login}: ${alvo.papel} → ${papel}`);
}

async function definirAtivo(ativo: boolean): Promise<void> {
  const login = exigir('login');
  const alvo = await porLogin(login);
  if (!alvo) {
    console.error(`[usuario] "${login}" não existe`);
    process.exit(1);
  }

  if (!ativo && alvo.papel === 'administrador') {
    const restantes = await consultarUm<{ total: number }>(
      `SELECT count(*)::int AS total FROM infoprice.ctl_usuario
        WHERE papel = 'administrador' AND ativo AND id <> $1`,
      [alvo.id],
    );
    if ((restantes?.total ?? 0) === 0) {
      console.error('[usuario] este é o último administrador ativo — promova outro antes');
      process.exit(1);
    }
  }

  await pool.query(
    'UPDATE infoprice.ctl_usuario SET ativo = $2, atualizado_em = now() WHERE id = $1',
    [alvo.id, ativo],
  );

  if (!ativo) {
    const derrubadas = await encerrarSessoesDoUsuario(alvo.id, 'usuário desativado via CLI');
    console.log(`[usuario] ${login} desativado · ${derrubadas} sessões encerradas`);
  } else {
    console.log(`[usuario] ${login} reativado`);
  }
}

const comandos: Record<string, () => Promise<void>> = {
  criar,
  listar,
  senha: redefinirSenha,
  papel: mudarPapel,
  desativar: () => definirAtivo(false),
  ativar: () => definirAtivo(true),
};

async function main(): Promise<void> {
  const comando = process.argv[2];
  const executar = comando ? comandos[comando] : undefined;

  if (!executar) {
    console.log('');
    console.log('  Comandos: criar · listar · senha · papel · desativar · ativar');
    console.log('');
    console.log('  npm run usuario --workspace @infoprice/server -- \\');
    console.log('      criar --login bruno.ruiz --nome "Bruno Ruiz" --papel administrador');
    console.log('');
    process.exitCode = comando ? 1 : 0;
    return;
  }

  await executar();
}

main()
  .then(() => fecharPool())
  .catch(async (erro) => {
    console.error('[usuario]', erro instanceof Error ? erro.message : erro);
    await fecharPool();
    process.exit(1);
  });
