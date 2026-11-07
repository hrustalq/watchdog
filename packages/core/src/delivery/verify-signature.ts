// A webhook's signature (docs: Actions and delivery, "Outbound webhook Action"). Only node:crypto, so a
// receiver written in Node can copy this file as it is.
import { createHmac, timingSafeEqual } from "node:crypto";

/** `timestamp` is the `X-Watchdog-Timestamp` header and `body` the request's raw text, before any JSON parsing. */
export function webhookSignature(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** This checks only the signature. A receiver that refuses old requests compares the timestamp itself. */
export function verifyWebhookSignature(request: { secret: string; timestamp: string; body: string; signature: string }) {
  const expected = Buffer.from(webhookSignature(request.secret, request.timestamp, request.body));
  const given = Buffer.from(request.signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
