// What the worker's sweep deletes, per Workspace, past its retention windows (docs: Processing
// pipeline, "Retention"): Items, the Log and Deliveries, and nothing inside a window.
import {
  action,
  actionDestination,
  closeDb,
  correction,
  createDb,
  type Db,
  delivery,
  destination,
  eq,
  item,
  itemLog,
  migrate,
  source,
  sql,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { purgeBatchSize, purgeExpiredRows } from "./delivery.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

/** A moment this many days ago, which is how far outside a window a seeded row sits. */
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

describe("the sweep's retention purge", () => {
  let postgres: TestPostgres;
  let db: Db;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** A Workspace with one Source, on these windows: null is unlimited. */
  async function newWorkspace(itemsDays: number | null, logDays: number | null) {
    const ownerId = crypto.randomUUID();
    await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
    const [row] = await db
      .insert(workspace)
      .values({ name: "Workspace", ownerUserId: ownerId, itemsRetentionDays: itemsDays, logRetentionDays: logDays })
      .returning();
    const workspaceId = present(row).id;
    const [src] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "rss",
        name: "Feed",
        config: { url: "https://feeds.test/feed.rss" },
        schedule: "*/15 * * * *",
      })
      .returning();
    return { workspaceId, sourceId: present(src).id };
  }

  /** An Item captured this many days ago, with the id the test looks it up by. */
  async function addItem(workspaceId: string, sourceId: string, externalId: string, days: number) {
    const [row] = await db
      .insert(item)
      .values({
        workspaceId,
        sourceId,
        externalId,
        title: `Title ${externalId}`,
        body: "An entry.",
        raw: {},
        capturedAt: daysAgo(days),
      })
      .returning();
    return present(row).id;
  }

  async function addLog(itemId: string, days: number, message: string) {
    await db.insert(itemLog).values({ itemId, at: daysAgo(days), stage: "capture", message });
  }

  /** A Delivery of this Item to a chat of its own, created this many days ago. */
  async function addDelivery(workspaceId: string, itemId: string, days: number) {
    const [chat] = await db
      .insert(destination)
      .values({ workspaceId, type: "telegram", name: `chat-${crypto.randomUUID()}`, confirmedAt: new Date() })
      .returning();
    const destinationId = present(chat).id;
    const [rule] = await db
      .insert(action)
      .values({
        workspaceId,
        name: `ones-${crypto.randomUUID()}`,
        kind: "alert",
        definition: { action: "ones", when: { field: "title", op: "is", value: "One" }, kind: "alert", destinations: [destinationId] },
      })
      .returning();
    const actionId = present(rule).id;
    await db.insert(actionDestination).values({ actionId, destinationId });
    const [row] = await db.insert(delivery).values({ actionId, itemId, destinationId, createdAt: daysAgo(days) }).returning();
    return present(row).id;
  }

  const messagesOf = async (itemId: string) =>
    (await db.select({ message: itemLog.message }).from(itemLog).where(eq(itemLog.itemId, itemId))).map(
      (row) => row.message,
    );
  const itemExists = async (id: string) => (await db.select({ id: item.id }).from(item).where(eq(item.id, id))).length > 0;
  const deliveryExists = async (id: string) =>
    (await db.select({ id: delivery.id }).from(delivery).where(eq(delivery.id, id))).length > 0;

  it("purges each table past its Workspace's window and leaves what is inside it", async () => {
    const { workspaceId, sourceId } = await newWorkspace(90, 30);
    const old = await addItem(workspaceId, sourceId, "old", 91);
    const live = await addItem(workspaceId, sourceId, "live", 10);
    await addLog(old, 91, "Captured 91 days ago");
    await addLog(live, 31, "Delivered 31 days ago");
    await addLog(live, 1, "Delivered a day ago");
    const oldDelivery = await addDelivery(workspaceId, old, 91);
    const staleDelivery = await addDelivery(workspaceId, live, 31);
    const freshDelivery = await addDelivery(workspaceId, live, 1);
    await db.insert(correction).values({
      workspaceId,
      itemId: old,
      kind: "rating",
      itemTitle: "Title old",
      itemSummary: "A summary the Correction copied",
      before: { severity: 2 },
      after: { severity: 5 },
    });
    // A second Workspace whose windows are longer than every one of those ages: nothing of it goes.
    const other = await newWorkspace(200, 200);
    const otherItem = await addItem(other.workspaceId, other.sourceId, "other", 91);
    await addLog(otherItem, 31, "Still inside the Log window");
    const otherDelivery = await addDelivery(other.workspaceId, otherItem, 31);

    const purged = await purgeExpiredRows(db);

    expect(purged).toEqual({ items: 1, logs: 1, deliveries: 1 });
    expect(await itemExists(old)).toBe(false);
    expect(await itemExists(live)).toBe(true);
    expect(await messagesOf(old)).toEqual([]);
    expect(await messagesOf(live)).toEqual(["Delivered a day ago"]);
    expect(await deliveryExists(oldDelivery)).toBe(false);
    expect(await deliveryExists(staleDelivery)).toBe(false);
    expect(await deliveryExists(freshDelivery)).toBe(true);
    // The Correction outlives its Item (#79): the copy is why it can still teach the Agent.
    const [kept] = await db.select().from(correction).where(eq(correction.workspaceId, workspaceId));
    expect(present(kept)).toMatchObject({
      itemId: null,
      itemTitle: "Title old",
      itemSummary: "A summary the Correction copied",
    });
    expect(await itemExists(otherItem)).toBe(true);
    expect(await messagesOf(otherItem)).toEqual(["Still inside the Log window"]);
    expect(await deliveryExists(otherDelivery)).toBe(true);
  });

  it("keeps everything for a Workspace whose windows are unlimited", async () => {
    const { workspaceId, sourceId } = await newWorkspace(null, null);
    const old = await addItem(workspaceId, sourceId, "unlimited", 4000);
    await addLog(old, 4000, "Captured long ago");
    const kept = await addDelivery(workspaceId, old, 4000);

    expect(await purgeExpiredRows(db)).toEqual({ items: 0, logs: 0, deliveries: 0 });
    expect(await itemExists(old)).toBe(true);
    expect(await messagesOf(old)).toEqual(["Captured long ago"]);
    expect(await deliveryExists(kept)).toBe(true);
  });

  it("applies a changed window on the next sweep", async () => {
    const { workspaceId, sourceId } = await newWorkspace(365, 365);
    const old = await addItem(workspaceId, sourceId, "changed", 91);
    await addLog(old, 31, "Delivered 31 days ago");

    expect(await purgeExpiredRows(db)).toEqual({ items: 0, logs: 0, deliveries: 0 });
    expect(await itemExists(old)).toBe(true);

    await db.update(workspace).set({ itemsRetentionDays: 30, logRetentionDays: 10 }).where(eq(workspace.id, workspaceId));

    // The Item goes with its Log row, which the cascade takes before the Log window is asked about.
    expect(await purgeExpiredRows(db)).toEqual({ items: 1, logs: 0, deliveries: 0 });
    expect(await itemExists(old)).toBe(false);
    expect(await messagesOf(old)).toEqual([]);
  });

  it("purges a backlog larger than one batch, and leaves the rows inside the window", async () => {
    const { workspaceId, sourceId } = await newWorkspace(1, 1);
    // One statement of the purge can only take `purgeBatchSize` rows, so a total above it is only
    // reachable by asking again: this is what the first sweep over a year of Items does.
    const backlog = purgeBatchSize * 2 + 500;
    await db.execute(sql`
      insert into item (workspace_id, source_id, external_id, body, raw, captured_at)
      select ${workspaceId}, ${sourceId}, 'backlog-' || n, 'An entry.', '{}', now() - interval '2 days'
      from generate_series(1, ${backlog}) as n
    `);
    const fresh = await addItem(workspaceId, sourceId, "fresh", 0);

    const started = performance.now();
    const purged = await purgeExpiredRows(db);
    const elapsed = Math.round(performance.now() - started);

    expect(purged).toEqual({ items: backlog, logs: 0, deliveries: 0 });
    expect(await itemExists(fresh)).toBe(true);
    expect(elapsed, `purged ${String(backlog)} Items in ${String(elapsed)} ms`).toBeLessThan(60_000);
  }, 120_000);
});
