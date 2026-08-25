import { config } from '../config.js';

/**
 * De onde sai a senha do banco.
 *
 * Os pacotes da AWS entram por import dinâmico e são dependências opcionais:
 * quem roda contra PostgreSQL local com senha no ambiente não precisa tê-los
 * instalados, e a imagem de produção não carrega o SDK à toa. O nome do módulo
 * fica numa variável de propósito — assim o TypeScript não exige o pacote em
 * tempo de compilação.
 */

async function importarOpcional(nome: string): Promise<Record<string, never>> {
  const especificador = nome;
  return (await import(/* @vite-ignore */ especificador)) as Record<string, never>;
}

interface SegredoRds {
  username?: string;
  password?: string;
  host?: string;
  port?: number;
  dbname?: string;
}

let segredoEmCache: SegredoRds | null = null;

/**
 * Lê o segredo do Secrets Manager.
 *
 * O valor fica em cache no processo. Se a senha for rotacionada, as conexões
 * novas só pegam a senha nova depois de reiniciar — que é o comportamento
 * esperado para rotação gerenciada, onde a senha antiga segue válida durante a
 * janela de transição. Para rotação sem reinício, use PG_CREDENCIAL=iam.
 */
async function doSecretsManager(): Promise<SegredoRds> {
  if (segredoEmCache) return segredoEmCache;

  if (!config.banco.segredoArn) {
    throw new Error(
      'PG_CREDENCIAL=secrets-manager exige PG_SEGREDO_ARN com o ARN ou nome do segredo',
    );
  }

  let modulo: {
    SecretsManagerClient: new (cfg: { region: string }) => {
      send: (cmd: unknown) => Promise<{ SecretString?: string }>;
    };
    GetSecretValueCommand: new (input: { SecretId: string }) => unknown;
  };

  try {
    modulo = (await importarOpcional('@aws-sdk/client-secrets-manager')) as never;
  } catch {
    throw new Error(
      'PG_CREDENCIAL=secrets-manager exige a dependência @aws-sdk/client-secrets-manager.\n' +
        'Instale com: npm i @aws-sdk/client-secrets-manager --workspace @infoprice/server',
    );
  }

  const cliente = new modulo.SecretsManagerClient({
    region: config.banco.regiaoAws,
  });
  const r = await cliente.send(
    new modulo.GetSecretValueCommand({ SecretId: config.banco.segredoArn }),
  );

  if (!r.SecretString) {
    throw new Error('o segredo não contém SecretString');
  }

  segredoEmCache = JSON.parse(r.SecretString) as SegredoRds;
  return segredoEmCache;
}

/**
 * Gera um token de autenticação IAM.
 *
 * O token vale 15 minutos, então é gerado a cada conexão nova em vez de uma vez
 * na subida. A vantagem sobre a senha fixa é que não existe segredo de longa
 * duração para vazar — e revogar o acesso é tirar a permissão no IAM, sem
 * precisar trocar senha em lugar nenhum.
 *
 * Exige `rds_iam` concedido ao usuário do banco e a política
 * `rds-db:connect` no papel da aplicação.
 */
async function tokenIam(): Promise<string> {
  let modulo: {
    Signer: new (cfg: {
      hostname: string;
      port: number;
      username: string;
      region: string;
    }) => { getAuthToken: () => Promise<string> };
  };

  try {
    modulo = (await importarOpcional('@aws-sdk/rds-signer')) as never;
  } catch {
    throw new Error(
      'PG_CREDENCIAL=iam exige a dependência @aws-sdk/rds-signer.\n' +
        'Instale com: npm i @aws-sdk/rds-signer --workspace @infoprice/server',
    );
  }

  const signer = new modulo.Signer({
    hostname: config.banco.host,
    port: config.banco.porta,
    username: config.banco.usuario,
    region: config.banco.regiaoAws,
  });

  return signer.getAuthToken();
}

/**
 * A senha entregue ao driver a cada conexão.
 *
 * O `pg` aceita uma função aqui e a chama por conexão, que é exatamente o que a
 * autenticação IAM precisa.
 */
export async function obterSenha(): Promise<string> {
  switch (config.banco.credencial) {
    case 'iam':
      return tokenIam();
    case 'secrets-manager': {
      const segredo = await doSecretsManager();
      if (!segredo.password) {
        throw new Error('o segredo não traz o campo "password"');
      }
      return segredo.password;
    }
    default:
      return config.banco.senha;
  }
}
