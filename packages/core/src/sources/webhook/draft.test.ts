import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { maxBodyBytes } from "../item.ts";
import { cleanPayload, mappingError, webhookDraft } from "./draft.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("webhookDraft", () => {
  it("without a mapping, names the Source, keeps the JSON as indented text and hashes the body", () => {
    const body = '{"title":"x","n":1}';
    const draft = webhookDraft(JSON.parse(body), bytes(body), "Deploys");
    expect(draft).toEqual({
      externalId: sha256(body),
      url: null,
      title: "Webhook to Deploys",
      author: null,
      body: '{\n  "title": "x",\n  "n": 1\n}',
      publishedAt: null,
      raw: { title: "x", n: 1 },
      captureNote: "It came through the webhook inbox",
    });
  });

  it("fills title, body, url and externalId from the mapping's first values", () => {
    const payload = {
      alert: { name: "Disk full", text: "92% used" },
      links: ["https://grafana.example.com/d/1", "https://second.example.com"],
      id: 42,
    };
    const body = JSON.stringify(payload);
    const draft = webhookDraft(payload, bytes(body), "Grafana", {
      title: "$.alert.name",
      body: "$.alert.text",
      url: "$.links[*]",
      externalId: "$.id",
    });
    expect(draft).toMatchObject({
      title: "Disk full",
      body: "92% used",
      url: "https://grafana.example.com/d/1",
      externalId: "42",
      raw: payload,
    });
  });

  it("treats a path that finds nothing, an object or an array as no mapping for that field", () => {
    const payload = { a: { b: 1 }, list: [1, 2] };
    const body = JSON.stringify(payload);
    const draft = webhookDraft(payload, bytes(body), "Hook", {
      title: "$.missing",
      body: "$.a",
      externalId: "$.list",
    });
    expect(draft.title).toBe("Webhook to Hook");
    expect(draft.body).toBe(JSON.stringify(payload, null, 2));
    expect(draft.externalId).toBe(sha256(body));
  });

  it("keeps only an http or https URL, since the Item page links to it", () => {
    const payload = { u: "javascript:alert(1)" };
    const draft = webhookDraft(payload, bytes(JSON.stringify(payload)), "Hook", { url: "$.u" });
    expect(draft.url).toBeNull();
  });

  it("caps the body", () => {
    const payload = { text: "é".repeat(maxBodyBytes) };
    const draft = webhookDraft(payload, bytes(JSON.stringify(payload)), "Hook", { body: "$.text" });
    expect(new TextEncoder().encode(draft.body).length).toBeLessThanOrEqual(maxBodyBytes);
  });
});

describe("webhookDraft's limits", () => {
  it("treats a blank mapped value as no value", () => {
    const payload = { id: " ", title: "" };
    const body = JSON.stringify(payload);
    const draft = webhookDraft(payload, bytes(body), "Hook", { externalId: "$.id", title: "$.title" });
    expect(draft.externalId).toBe(sha256(body));
    expect(draft.title).toBe("Webhook to Hook");
  });

  it("hashes a mapped external ID too long for the index, and caps the title", () => {
    const long = "x".repeat(5000);
    const payload = { id: long, title: long };
    const draft = webhookDraft(payload, bytes(JSON.stringify(payload)), "Hook", { externalId: "$.id", title: "$.title" });
    expect(draft.externalId).toBe(sha256(long));
    expect(draft.title?.length).toBeLessThanOrEqual(500);
  });
});

describe("cleanPayload", () => {
  it("drops NUL and lone surrogates from keys and strings, which Postgres jsonb refuses", () => {
    expect(cleanPayload({ "a\0": "b\0c", list: ["\ud800x"] })).toEqual({ a: "bc", list: ["\ufffdx"] });
  });

  it("refuses JSON nested more deeply than a Rule's JSONPath or Postgres would walk", () => {
    expect(cleanPayload(JSON.parse("[".repeat(500_000) + "]".repeat(500_000)))).toBeUndefined();
    expect(cleanPayload(JSON.parse("[".repeat(64) + "]".repeat(64)))).toBeDefined();
  });
});

describe("mappingError", () => {
  it("accepts a JSONPath and refuses one the Rule model's limits refuse", () => {
    expect(mappingError("$.alert.name")).toBeUndefined();
    expect(mappingError("not a path")).toMatch(/isn't a JSONPath/);
    expect(mappingError("$..a..b")).toMatch(/descendant/);
  });
});
