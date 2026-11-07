import { describe, expect, it } from "vitest";
import { verifyWebhookSignature, webhookSignature } from "./verify-signature.ts";

const secret = "a-webhook-secret";
const timestamp = "1700000000";
const body = '{"version":1}';
// From: printf '%s' '1700000000.{"version":1}' | openssl dgst -sha256 -hmac 'a-webhook-secret'
const signature = "sha256=ea80eee48303c9c5e559e57f44b73b7eac1a8a48323b39004c3543443c90d48e";

describe("webhookSignature", () => {
  it("is sha256= and the hex HMAC-SHA256 of the timestamp, a dot and the body", () => {
    expect(webhookSignature(secret, timestamp, body)).toBe(signature);
  });
});

describe("verifyWebhookSignature", () => {
  const signed = { secret, timestamp, body, signature };

  it("accepts a signed request", () => {
    expect(verifyWebhookSignature(signed)).toBe(true);
  });

  it.each([
    ["a changed body", { body: '{"version":2}' }],
    ["a changed timestamp", { timestamp: "1700000001" }],
    ["another secret", { secret: "another-secret" }],
    ["a signature of another length", { signature: "sha256=ea80" }],
    ["no signature", { signature: "" }],
  ])("rejects %s", (_name, change) => {
    expect(verifyWebhookSignature({ ...signed, ...change })).toBe(false);
  });
});
