import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';

let transporte: Transporter | null = null;
let avisouSemSmtp = false;

function obterTransporte(): Transporter | null {
  if (!config.alertas.smtpHost) return null;
  if (transporte) return transporte;

  transporte = nodemailer.createTransport({
    host: config.alertas.smtpHost,
    port: config.alertas.smtpPorta,
    secure: config.alertas.smtpPorta === 465,
    auth: config.alertas.smtpUsuario
      ? {
          user: config.alertas.smtpUsuario,
          pass: config.alertas.smtpSenha,
        }
      : undefined,
  });
  return transporte;
}

export interface Mensagem {
  assunto: string;
  texto: string;
  destinatarios?: string[];
}

/**
 * Envia o e-mail do alerta.
 *
 * Sem SMTP configurado o alerta continua valendo — ele já está no painel, que é
 * o canal obrigatório. Aqui apenas registramos que o e-mail não saiu, uma vez
 * só, para não poluir o log a cada execução.
 */
export async function enviarEmail(msg: Mensagem): Promise<boolean> {
  const destino = (msg.destinatarios ?? config.alertas.destinatarios).filter(
    Boolean,
  );
  if (destino.length === 0) return false;

  const t = obterTransporte();
  if (!t) {
    if (!avisouSemSmtp) {
      console.warn(
        '[alertas] SMTP não configurado — os alertas seguem apenas pelo painel. ' +
          'Defina SMTP_HOST para habilitar o e-mail.',
      );
      avisouSemSmtp = true;
    }
    return false;
  }

  try {
    await t.sendMail({
      from: config.alertas.remetente,
      to: destino.join(', '),
      subject: msg.assunto,
      text: msg.texto,
    });
    return true;
  } catch (erro) {
    console.error(
      '[alertas] falha ao enviar e-mail:',
      erro instanceof Error ? erro.message : erro,
    );
    return false;
  }
}
