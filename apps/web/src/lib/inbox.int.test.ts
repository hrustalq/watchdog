import { itemEnqueuer, processItemQueue } from "@watchdog/core";
import { and, closeDb, createDb, type Db, eq, item, itemLog, migrate, source, sql, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { PgBoss } from "pg-boss";
import { beforeAll, describe, expect, it } from "vitest";
import { feedPage } from "./feed.ts";
import { inboxUrl, receiveInbox, replaceInboxToken, revealInboxToken } from "./inbox.ts";
import { addValues, addWebhookSource, problemField } from "./sources.ts";

const encryptionKey = Buffer.alloc(32, 5);
const baseURL = "http://localhost:3000";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Expected a value");
  return value;
}

/** The Item id an inbox answer carries. */
async function idOf(response: Response) {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("id" in body) || typeof body.id !== "string") {
    throw new Error(`No id in ${JSON.stringify(body)}`);
  }
  return body.id;
}

describe("webhook inbox", () => {
  let db: Db;
  let boss: PgBoss;
  let workspaceId = "";
  let now = new Date("2026-11-10T12:00:00Z");
  const deps = () => ({ enqueueItems: itemEnqueuer(boss), now: () => now });

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values({ id: "us", name: "Us", email: "us@example.com" });
    const [ws] = await db.insert(workspace).values({ name: "Ours", ownerUserId: "us" }).returning();
    workspaceId = present(ws).id;
    // The worker creates the queue in production; nothing works its jobs here, so a test can see them.
    boss = new PgBoss(postgres.url);
    await boss.start();
    await boss.createQueue(processItemQueue);
    return async () => {
      await boss.stop();
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** A new inbox, and its token as the page shows it once. */
  async function newInbox(mapping: Partial<Record<"mapTitle" | "mapBody" | "mapUrl" | "mapExternalId", string>> = {}) {
    const values = { ...addValues(() => ""), type: "webhook" as const, name: "Deploys", ...mapping };
    const added = await addWebhookSource(db, encryptionKey, workspaceId, values);
    if (!("source" in added)) throw new Error(`Not added: ${added.problem}`);
    const token = present(await revealInboxToken(db, encryptionKey, workspaceId, added.source.id));
    return { id: added.source.id, token };
  }

  const post = (token: string, body: BodyInit, type = "application/json", init: RequestInit = {}) =>
    receiveInbox(
      db,
      deps(),
      token,
      new Request(inboxUrl(baseURL, token), { method: "POST", headers: { "content-type": type }, body, ...init }),
    );

  it("captures a JSON body as an Item with its process-item job, and answers 202 with its id", async () => {
    const { id: sourceId, token } = await newInbox();
    const response = await post(token, '{"title":"x"}');
    expect(response.status).toBe(202);
    const id = await idOf(response);
    const saved = present(await db.query.item.findFirst({ where: eq(item.id, id) }));
    expect(saved).toMatchObject({ sourceId, title: "Webhook to Deploys", raw: { title: "x" }, isBackfill: false });
    const [log] = await db.select().from(itemLog).where(eq(itemLog.itemId, id));
    expect(log?.message).toBe("Captured from Deploys. It came through the webhook inbox");
    const jobs = await db.execute(sql`select data from pgboss.job where name = ${processItemQueue} and data->>'itemId' = ${id}`);
    expect(jobs.rows).toHaveLength(1);
    const feed = await feedPage(db, workspaceId);
    expect(feed.items.map((row) => row.id)).toContain(id);
  });

  it("answers 200 with the same id for a body it already captured, and captures nothing", async () => {
    const { id: sourceId, token } = await newInbox();
    const first = await idOf(await post(token, '{"a":1}'));
    const again = await post(token, '{"a":1}');
    expect(again.status).toBe(200);
    expect(await idOf(again)).toBe(first);
    expect(await db.$count(item, eq(item.sourceId, sourceId))).toBe(1);
  });

  it("fills the Item from the mapping", async () => {
    const { token } = await newInbox({ mapTitle: "$.alert.name", mapUrl: "$.link", mapExternalId: "$.id" });
    const body = JSON.stringify({ alert: { name: "Disk full" }, link: "https://grafana.example.com/d/1", id: 7 });
    const id = await idOf(await post(token, body));
    expect(await db.query.item.findFirst({ where: eq(item.id, id) })).toMatchObject({
      title: "Disk full",
      url: "https://grafana.example.com/d/1",
      externalId: "7",
    });
  });

  it("answers 401 to an unknown token, before anything else", async () => {
    const response = await post("not-a-token", "plain", "text/plain");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unknown inbox" });
  });

  it("stops the old token at once when the token is replaced", async () => {
    const { id, token } = await newInbox();
    expect(await replaceInboxToken(db, encryptionKey, workspaceId, id)).toBe(true);
    expect((await post(token, "{}")).status).toBe(401);
    const fresh = present(await revealInboxToken(db, encryptionKey, workspaceId, id));
    expect((await post(fresh, "{}")).status).toBe(202);
    // Another Workspace's id replaces nothing.
    expect(await replaceInboxToken(db, encryptionKey, crypto.randomUUID(), id)).toBe(false);
  });

  it("answers 415 to a body that isn't JSON, and takes a +json type", async () => {
    const { token } = await newInbox();
    expect((await post(token, "a=1", "application/x-www-form-urlencoded")).status).toBe(415);
    expect((await post(token, '{"b":1}', "application/vnd.example+json; charset=utf-8")).status).toBe(202);
  });

  it("answers 413 to a body over 1 MB, counted as it is read", async () => {
    const { token } = await newInbox();
    const big = JSON.stringify({ text: "x".repeat(2 * 1024 * 1024) });
    expect((await post(token, big)).status).toBe(413);
    // A stream has no Content-Length, so only reading it can tell.
    const stream = new Blob([big]).stream();
    // Node needs duplex to send a stream, which the DOM's RequestInit doesn't list.
    const streamed: RequestInit & { duplex: "half" } = { duplex: "half" };
    expect((await post(token, stream, "application/json", streamed)).status).toBe(413);
  });

  it("answers 400 to a body that isn't valid JSON", async () => {
    const { token } = await newInbox();
    expect((await post(token, "{nope")).status).toBe(400);
  });

  it("answers 429 with Retry-After past 60 requests a minute, and takes requests again the next minute", async () => {
    const { token } = await newInbox();
    for (let i = 0; i < 60; i++) expect((await post(token, "{nope")).status).toBe(400);
    const limited = await post(token, "{}");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    now = new Date(now.getTime() + 61_000);
    expect((await post(token, "{}")).status).toBe(202);
  });

  it("keeps only the token's hash once the page has shown it, and shows it once", async () => {
    const { id, token } = await newInbox();
    expect(await revealInboxToken(db, encryptionKey, workspaceId, id)).toBeUndefined();
    const row = present(await db.query.source.findFirst({ where: and(eq(source.id, id)) }));
    expect(row.secretCiphertext).toBeNull();
    expect(row.inboxTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ type: "webhook", schedule: null, nextPollAt: null, dedupKey: null });
  });

  it("refuses a mapping path the Rule model's limits refuse", async () => {
    const values = { ...addValues(() => ""), type: "webhook" as const, mapBody: "$..a..b" };
    expect(await addWebhookSource(db, encryptionKey, workspaceId, values)).toEqual({ problem: "invalid-mapping" });
    expect(problemField("invalid-mapping", "webhook", values)).toBe("mapBody");
  });
});
