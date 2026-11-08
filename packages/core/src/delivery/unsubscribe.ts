// The signed URL a Digest mail's one-click unsubscribe goes to (docs: Security and privacy, "The
// unsubscribe URL"; Actions and delivery, "Digests"). It needs no session, so the signature is the check.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A key of its own, so a signature here can't stand for anything Better Auth signs with the secret. */
const keyFrom = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "", "watchdog digest unsubscribe", 32));

const sign = (secret: string, actionId: string, destinationId: string) =>
  createHmac("sha256", keyFrom(secret)).update(`${actionId}.${destinationId}`).digest();

/** Where a Digest mail to a Destination unsubscribes it. It doesn't expire, because it sits in mail kept for years. */
export function unsubscribeUrl(appUrl: string, secret: string, actionId: string, destinationId: string) {
  const url = new URL("/unsubscribe", appUrl);
  url.searchParams.set("token", `${actionId}.${destinationId}.${sign(secret, actionId, destinationId).toString("base64url")}`);
  return url.href;
}

/** The Action and Destination a token names, or undefined for any token this install didn't sign. */
export function checkUnsubscribeToken(token: string, secret: string) {
  const [actionId, destinationId, signature, ...rest] = token.split(".");
  if (actionId === undefined || destinationId === undefined || signature === undefined || rest.length > 0) return undefined;
  if (!uuid.test(actionId) || !uuid.test(destinationId)) return undefined;
  const expected = sign(secret, actionId, destinationId);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return { actionId, destinationId };
}
