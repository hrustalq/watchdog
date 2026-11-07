import { describe, expect, it } from "vitest";
import { EgressBlockedError, EgressLimitError } from "../egress/egress.ts";
import { encryptSecret } from "../secrets/secrets.ts";
import type { WebhookMessage } from "./content.ts";
import { type Destination, FinalSendError } from "./deliver.ts";
import { verifyWebhookSignature } from "./verify-signature.ts";
import { createWebhookSender } from "./webhook.ts";

const encryptionKey = Buffer.alloc(32, 7);
const secret = "a-webhook-secret";
const url = "https://hooks.test/watchdog";

const hook: Destination = {
  id: "0a1b",
  workspaceId: "0a1c",
  type: "webhook",
  name: "ops-hook",
  config: { url },
  secretCiphertext: encryptSecret(secret, encryptionKey),
  secretShownAt: null,
  confirmedAt: null,
  lastError: null,
  lastErrorAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const message: WebhookMessage = {
  action: "critical",
  item: {
    id: "0b1c",
    sourceId: "0b1d",
    externalId: "one",
    url: "https://news.test/one",
    title: "A security advisory",
    author: null,
    body: "An entry.",
    publishedAt: new Date("2026-11-07T10:00:00.000Z"),
    capturedAt: new Date("2026-11-07T10:05:00.000Z"),
    language: "en",
    isBackfill: false,
    summary: "Patch now.",
  },
  rating: { severity: 5, importance: 3 },
  categories: ["security-advisory"],
  fields: { cve: "CVE-2026-1" },
  firedBecause: "Severity is at least 4",
};

type EgressFetch = Parameters<typeof createWebhookSender>[0]["fetch"];

/** A fake receiver that records each request and answers the same way each time. */
function receiver(answer: () => Promise<Response>) {
  const requests: { url: string; headers: Headers; body: string; method: string | undefined }[] = [];
  const fetch: EgressFetch = (input, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url: String(input), headers: new Headers(init?.headers), body, method: init?.method });
    return answer();
  };
  return { requests, sender: createWebhookSender({ fetch, encryptionKey, mode: "hosted" }) };
}

const answering = (status: number, text: string | null = null) =>
  receiver(() => Promise.resolve(new Response(text, { status })));
const throwing = (error: Error) => receiver(() => Promise.reject(error));

/** The error a send rejected with, which the test expects there to be. */
async function failure(sending: Promise<void>) {
  const error: unknown = await sending.catch((rejected: unknown) => rejected);
  if (!(error instanceof Error)) throw new Error("Expected the send to fail");
  return error;
}

describe("the webhook sender", () => {
  it("POSTs the message as JSON to the Destination's URL, with the version first", async () => {
    const { requests, sender } = answering(200);

    await sender.send(hook, message);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(url);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(requests[0]?.headers.get("user-agent")).toBe("Watchdog");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      version: 1,
      action: "critical",
      item: {
        id: "0b1c",
        sourceId: "0b1d",
        externalId: "one",
        url: "https://news.test/one",
        title: "A security advisory",
        author: null,
        body: "An entry.",
        publishedAt: "2026-11-07T10:00:00.000Z",
        capturedAt: "2026-11-07T10:05:00.000Z",
        language: "en",
        isBackfill: false,
        summary: "Patch now.",
      },
      rating: { severity: 5, importance: 3 },
      categories: ["security-advisory"],
      fields: { cve: "CVE-2026-1" },
      firedBecause: "Severity is at least 4",
    });
  });

  it("signs the timestamp and the body with the Destination's secret, so a receiver can verify them", async () => {
    const { requests, sender } = answering(200);
    const before = Math.floor(Date.now() / 1000);

    await sender.send(hook, message);

    const headers = requests[0]?.headers;
    const timestamp = headers?.get("x-watchdog-timestamp") ?? "";
    const signature = headers?.get("x-watchdog-signature") ?? "";
    expect(timestamp).toMatch(/^\d+$/);
    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(timestamp)).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000));
    const body = requests[0]?.body ?? "";
    expect(verifyWebhookSignature({ secret, timestamp, body, signature })).toBe(true);
    expect(verifyWebhookSignature({ secret, timestamp, body: `${body} `, signature })).toBe(false);
  });

  it.each([200, 201, 202, 204, 299])("counts a %i as sent", async (status) => {
    const { sender } = answering(status);

    await expect(sender.send(hook, message)).resolves.toBeUndefined();
  });

  it.each([408, 429, 500, 502, 503])("fails a %i so it retries, saying the status", async (status) => {
    const { sender } = answering(status);

    const error = await failure(sender.send(hook, message));

    expect(error).not.toBeInstanceOf(FinalSendError);
    expect(error.message).toBe(`the receiver answered ${String(status)}`);
  });

  it.each([400, 401, 403, 404, 410, 422])("fails a %i at once, saying the status", async (status) => {
    const { sender } = answering(status);

    const error = await failure(sender.send(hook, message));

    expect(error).toBeInstanceOf(FinalSendError);
    expect(error.message).toBe(`the receiver answered ${String(status)}`);
  });

  it("keeps none of the receiver's answer", async () => {
    const { sender } = answering(500, "the receiver's private data");

    const error = await failure(sender.send(hook, message));

    expect(error.message).not.toContain("private data");
  });

  it("retries a network error, saying what went wrong", async () => {
    const { sender } = throwing(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }));

    const error = await failure(sender.send(hook, message));

    expect(error).not.toBeInstanceOf(FinalSendError);
    expect(error.message).toBe("the receiver can't be reached: connect ECONNREFUSED");
  });

  it("retries the egress guard's limit", async () => {
    const { sender } = throwing(new EgressLimitError("hooks.test took longer than 30000 ms"));

    const error = await failure(sender.send(hook, message));

    expect(error).toBeInstanceOf(EgressLimitError);
    expect(error).not.toBeInstanceOf(FinalSendError);
  });

  it("fails at once when the egress guard blocks the URL, without saying what the host resolved to", async () => {
    const { sender } = throwing(
      new EgressBlockedError("hooks.test", "it resolves to the blocked address 10.0.0.5", "10.0.0.5"),
    );

    const error = await failure(sender.send(hook, message));

    expect(error).toBeInstanceOf(FinalSendError);
    expect(error.message).toBe(
      "the URL, or a redirect from it, goes to a private, local or non-web address, which Watchdog doesn't call",
    );
    expect(error.message).not.toContain("10.0.0.5");
  });

  it("says on self-hosted how to allow a blocked address", async () => {
    const blocked = new EgressBlockedError("hooks.test", "it resolves to the blocked address 10.0.0.5", "10.0.0.5");
    const sender = createWebhookSender({
      fetch: () => Promise.reject(blocked),
      encryptionKey,
      mode: "self-hosted",
    });

    const error = await failure(sender.send(hook, message));

    expect(error).toBeInstanceOf(FinalSendError);
    expect(error.message).toMatch(/non-web address, which Watchdog doesn't call\. .*EGRESS_ALLOWLIST/);
    expect(error.message).not.toContain("10.0.0.5");
  });

  it.each([
    ["no secret", { secretCiphertext: null }],
    ["no URL", { config: {} }],
  ])("fails at once with %s, without calling anything", async (_name, change) => {
    const { requests, sender } = answering(200);

    await expect(sender.send({ ...hook, ...change }, message)).rejects.toBeInstanceOf(FinalSendError);

    expect(requests).toEqual([]);
  });
});
