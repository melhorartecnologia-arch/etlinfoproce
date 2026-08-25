import { config } from '../config.js';
import type { DriverOrigem } from './driver.js';
import { OrigemLocal } from './origem-local.js';
import { SftpRemoto } from './sftp-remoto.js';

export type { ArquivoRemoto, DriverOrigem, PastaRemota } from './driver.js';

export function criarDriverOrigem(): DriverOrigem {
  return config.sftp.driver === 'sftp' ? new SftpRemoto() : new OrigemLocal();
}

/** Abre a conexão, roda o callback e fecha mesmo em caso de erro. */
export async function comOrigem<T>(
  fn: (driver: DriverOrigem) => Promise<T>,
): Promise<T> {
  const driver = criarDriverOrigem();
  await driver.conectar();
  try {
    return await fn(driver);
  } finally {
    await driver.desconectar();
  }
}
