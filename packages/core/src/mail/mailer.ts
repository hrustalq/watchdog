// All mail goes through this one interface: magic links now, alerts and Digests later. See
// "Email" on the System overview and runtime page in Knowledge.
import { createTransport } from "nodemailer";
import type { Config } from "../config.ts";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** The sender, when it isn't SMTP_FROM. */
  from?: string | undefined;
}

export interface Mailer {
  send: (message: MailMessage) => Promise<void>;
}

/**
 * Sends over SMTP when it is configured. Without SMTP (self-hosted only, since hosted requires it)
 * the message is printed to `log`, the process's stdout, so the operator can open a magic link
 * from the web container's log.
 */
export function createMailer(
  config: Pick<Config, "mode" | "smtp">,
  log: NodeJS.WritableStream = process.stdout,
): Mailer {
  const { mode, smtp } = config;
  if (smtp === undefined) {
    return {
      send: ({ to, subject, text }) => {
        log.write(`SMTP is not configured, so this mail is printed instead of sent.\n`);
        log.write(`To: ${to}\nSubject: ${subject}\n\n${text}\n\n`);
        return Promise.resolve();
      },
    };
  }

  // Port 587 upgrades to TLS with STARTTLS. Hosted insists on it, so a stripped STARTTLS can't
  // expose the login or a magic link; self-hosted also allows a local relay without TLS.
  const transport = createTransport({
    host: smtp.host,
    port: smtp.port,
    auth: { user: smtp.user, pass: smtp.password },
    requireTLS: mode === "hosted",
    // The defaults let a stalled server hold a send for 12.5 minutes, and a send to a Destination makes
    // the others wait for it.
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 60_000,
  });
  return {
    send: async ({ to, subject, text, from }) => {
      await transport.sendMail({ from: from ?? smtp.from, to, subject, text });
    },
  };
}
