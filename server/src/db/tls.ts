import fs from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import { config } from '../config.js';

/**
 * Configuração de TLS da conexão com o banco.
 *
 * O caso que importa é o RDS: em `verify-full` o certificado é conferido contra
 * o bundle de CAs da AWS e o hostname precisa bater. É o que distingue "a
 * conexão está cifrada" de "a conexão está cifrada com quem eu penso que é" —
 * sem a verificação, um interceptor na rota apresenta o próprio certificado e a
 * cifra não protege de nada.
 *
 * Devolve `undefined` quando o TLS está desligado (PostgreSQL local).
 */
export function opcoesTls(): ConnectionOptions | undefined {
  const modo = config.banco.sslModo;

  if (modo === 'disable') return undefined;

  if (modo === 'require') {
    // Cifra sem conferir quem está do outro lado. Protege de escuta passiva,
    // não de interceptação ativa.
    console.warn(
      '[pg] PGSSLMODE=require: a conexão será cifrada, mas o certificado do ' +
        'servidor NÃO será verificado. Prefira verify-full com o bundle da AWS.',
    );
    return { rejectUnauthorized: false };
  }

  // verify-full
  const caminho = config.banco.caRds;
  if (!fs.existsSync(caminho)) {
    throw new Error(
      `PGSSLMODE=verify-full exige o bundle de CAs do RDS em ${caminho}, que não existe.\n` +
        'Baixe com: npm run baixar-ca-rds --workspace @infoprice/server\n' +
        'Ou aponte CA_RDS para o bundle já provisionado na imagem.',
    );
  }

  const ca = fs.readFileSync(caminho, 'utf8');
  if (!ca.includes('BEGIN CERTIFICATE')) {
    throw new Error(`o arquivo ${caminho} não parece um bundle PEM válido`);
  }

  return {
    ca,
    rejectUnauthorized: true,
    // O certificado do RDS é emitido para o endpoint; conferir o hostname é o
    // que impede aceitar um certificado válido emitido para outra instância.
    servername: config.banco.host,
  };
}

/** Resumo legível do modo de TLS, para o log de subida e o health check. */
export function descreverTls(): string {
  switch (config.banco.sslModo) {
    case 'verify-full':
      return `TLS verificado contra ${config.banco.caRds.split('/').pop()}`;
    case 'require':
      return 'TLS sem verificação de certificado (require)';
    default:
      return 'sem TLS';
  }
}
