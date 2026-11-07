// Calls webhook Destinations (docs: Actions and delivery, "Outbound webhook Action").
import { z } from "zod";
import { type createEgressFetch, EgressBlockedError } from "../egress/egress.ts";
import { decryptSecret } from "../secrets/secrets.ts";
import type { WebhookMessage } from "./content.ts";
import { FinalSendError, type Sender, unreachable } from "./deliver.ts";
import { webhookSignature } from "./verify-signature.ts";

const webhookConfig = z.object({ url: z.url() });

/** A 408 or a 429 can pass with time. Any other 4xx says the request itself is wrong. */
const isFinal = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

export function createWebhookSender(deps: {
  /** The egress guard's fetch, as for every request out of Watchdog. */
  fetch: ReturnType<typeof createEgressFetch>;
  encryptionKey: Buffer;
}): Sender<WebhookMessage> {
  return {
    send: async (destination, message) => {
      if (destination.secretCiphertext === null) throw new FinalSendError("the webhook has no secret");
      const config = webhookConfig.safeParse(destination.config);
      if (!config.success) throw new FinalSendError("the webhook has no valid URL");

      const secret = decryptSecret(destination.secretCiphertext, deps.encryptionKey);
      const body = JSON.stringify({ version: 1, ...message });
      // Signed for each attempt, so a retry isn't refused as an old request.
      const timestamp = String(Math.floor(Date.now() / 1000));

      const response = await deps
        .fetch(config.data.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Watchdog",
            "x-watchdog-timestamp": timestamp,
            "x-watchdog-signature": webhookSignature(secret, timestamp, body),
          },
          body,
        })
        .catch((error: unknown) => {
          // The guard's message names the address the host resolved to, which the Log's reader may not
          // be allowed to learn on hosted, as with a Source's URL.
          if (error instanceof EgressBlockedError) {
            throw new FinalSendError("the URL is a private, local or non-web address, which Watchdog doesn't call");
          }
          throw unreachable(error, "the receiver");
        });

      // The answer is someone else's data, so only its status is ever looked at.
      const { ok, status } = response;
      await response.body?.cancel().catch(() => undefined);
      if (ok) return;
      const refused = `the receiver answered ${String(status)}`;
      throw isFinal(status) ? new FinalSendError(refused) : new Error(refused);
    },
  };
}
