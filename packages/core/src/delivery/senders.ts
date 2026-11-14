// The senders every delivery goes through. The worker sends Deliveries with them, and the web app sends
// test alerts, so both build them here.
import type { Config } from "../config.ts";
import type { createEgressFetch } from "../egress/egress.ts";
import type { Mailer } from "../mail/mailer.ts";
import type { AlertSender, DeliverDeps } from "./deliver.ts";
import { createEmailSender } from "./email.ts";
import { createTelegramSender, type FloodLimiter } from "./telegram.ts";
import { createWebhookSender } from "./webhook.ts";

export function createSenders(
  config: Pick<Config, "mode" | "encryptionKey" | "smtp" | "telegram">,
  deps: {
    fetch: ReturnType<typeof createEgressFetch>;
    mailer: Mailer;
    /** The limits the Telegram sender keeps to, when the caller shares them with another sender. */
    telegramLimiter?: FloodLimiter;
  },
): { telegram: AlertSender; email: AlertSender; webhook: DeliverDeps["senders"]["webhook"] } {
  const { fetch, mailer } = deps;
  const { encryptionKey, mode } = config;
  return {
    telegram: createTelegramSender(config.telegram.botToken, {
      fetch,
      encryptionKey,
      ...(deps.telegramLimiter !== undefined && { limiter: deps.telegramLimiter }),
    }),
    email: createEmailSender(mailer, config.smtp?.alertFrom),
    webhook: createWebhookSender({ fetch, encryptionKey, mode }),
  };
}
