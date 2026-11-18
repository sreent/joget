import { readFile } from 'node:fs/promises';
import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

/** An email to one person, as plain text. */
export interface Mail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

/** Sends email. The platform's is SMTP; tests keep what it would send. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * Email through the installation's SMTP server. On smtp:// it must offer STARTTLS, so nothing goes
 * out in the clear. The password is read from its file at each sending, so whatever issues it can
 * renew it.
 */
export function smtpMailer(config: Pick<Config, 'SMTP_URL' | 'SMTP_USER' | 'SMTP_PASSWORD_FILE' | 'MAIL_FROM'>): Mailer {
  const url = new URL(config.SMTP_URL!);
  const secure = url.protocol === 'smtps:';
  return {
    async send(mail) {
      const pass = config.SMTP_PASSWORD_FILE ? (await readFile(config.SMTP_PASSWORD_FILE, 'utf8')).trim() : undefined;
      const transport = nodemailer.createTransport({
        host: url.hostname,
        port: Number(url.port) || (secure ? 465 : 587),
        secure,
        requireTLS: !secure,
        ...(config.SMTP_USER && pass ? { auth: { user: config.SMTP_USER, pass } } : {}),
      });
      try {
        await transport.sendMail({ from: config.MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text });
      } finally {
        transport.close();
      }
    },
  };
}
