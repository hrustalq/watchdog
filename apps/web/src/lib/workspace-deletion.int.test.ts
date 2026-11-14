// Deleting a Workspace from Settings: the account row goes, every child table cascades, and a
// self-hosted install whose admin went is unclaimed again (docs: Security and privacy, "Deleting and
// exporting a Workspace").
import {
  action,
  actionDestination,
  account,
  agentCall,
  classifier,
  closeDb,
  correction,
  createDb,
  type Db,
  delivery,
  destination,
  digestItem,
  eq,
  extractorRule,
  healthAlertDestination,
  instanceSettings,
  item,
  itemCategory,
  itemField,
  itemLog,
  migrate,
  modelConfig,
  profile,
  sentMessage,
  session,
  source,
  sourceAlert,
  telegramLogin,
  telegramSession,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import type { PgBoss } from "pg-boss";
import { beforeAll, describe, expect, it } from "vitest";
import { setupTokenValid, setupUrl } from "./instance.ts";
import { afterDeletion, type BeforeDelete, deleteWorkspace } from "./workspace-deletion.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

/** Nothing here queues a job: #314 is the first pre-delete step to need one. */
function boss(): Promise<PgBoss> {
  return Promise.reject(new Error("Nothing queues a job for a deleted Workspace yet"));
}

describe("deleting a Workspace", () => {
  let db: Db;

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** A Workspace with a row in every table that belongs to one, and the ids the counts read by. */
  async function seed() {
    const ownerId = crypto.randomUUID();
    await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
    await db.insert(session).values({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      userId: ownerId,
    });
    await db.insert(account).values({
      id: crypto.randomUUID(),
      accountId: ownerId,
      providerId: "credential",
      userId: ownerId,
    });
    const [ws] = await db.insert(workspace).values({ name: "Morning coffee", ownerUserId: ownerId }).returning();
    const workspaceId = present(ws).id;

    const [rule] = await db
      .insert(classifier)
      .values({
        workspaceId,
        name: "ones",
        kind: "deterministic",
        definition: { classifier: "ones", when: { field: "title", op: "is", value: "One" }, assign: ["one"] },
      })
      .returning();
    const [extractor] = await db
      .insert(extractorRule)
      .values({
        workspaceId,
        name: "price",
        kind: "deterministic",
        definition: { extractor: "price", field: "price", from: "title" },
      })
      .returning();
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
    const sourceId = present(src).id;
    const [captured] = await db
      .insert(item)
      .values({ workspaceId, sourceId, externalId: "one", title: "One", body: "An entry.", raw: {} })
      .returning();
    const itemId = present(captured).id;
    await db.insert(itemLog).values({ itemId, stage: "capture", message: "Captured from Feed" });
    await db.insert(itemCategory).values({ itemId, category: "one", classifierId: present(rule).id });
    await db.insert(itemField).values({ itemId, name: "price", value: 3, extractorRuleId: present(extractor).id });
    await db.insert(correction).values({
      workspaceId,
      itemId,
      kind: "rating",
      itemTitle: "One",
      before: { severity: 2 },
      after: { severity: 5 },
    });
    await db.insert(profile).values({ workspaceId, body: "I want coffee news." });
    const [model] = await db
      .insert(modelConfig)
      .values({ workspaceId, providerType: "openai-compatible", baseUrl: "https://model.test/v1", modelName: "m" })
      .returning();
    await db.insert(agentCall).values({
      workspaceId,
      modelConfigId: present(model).id,
      itemId,
      purpose: "classify",
      attempt: 1,
      latencyMs: 12,
      status: "ok",
    });

    const [chat] = await db
      .insert(destination)
      .values({ workspaceId, type: "telegram", name: "ops-chat", confirmedAt: new Date() })
      .returning();
    const destinationId = present(chat).id;
    const when = { field: "title", op: "is", value: "One" };
    const [alert] = await db
      .insert(action)
      .values({ workspaceId, name: "ones", kind: "alert", definition: { action: "ones", when, kind: "alert", destinations: [destinationId] } })
      .returning();
    const [digest] = await db
      .insert(action)
      .values({
        workspaceId,
        name: "daily",
        kind: "digest",
        definition: { action: "daily", when, kind: "digest", schedule: "0 9 * * *", destinations: [destinationId] },
      })
      .returning();
    await db.insert(actionDestination).values({ actionId: present(alert).id, destinationId });
    await db.insert(actionDestination).values({ actionId: present(digest).id, destinationId });
    await db.insert(delivery).values({ actionId: present(alert).id, itemId, destinationId });
    await db.insert(digestItem).values({ actionId: present(digest).id, itemId, destinationId });
    await db.insert(healthAlertDestination).values({ workspaceId, destinationId });
    await db.insert(sentMessage).values({ workspaceId, destinationId, type: "telegram", sentAt: new Date() });
    await db.insert(sourceAlert).values({ workspaceId, sourceId, kind: "failing", error: "The feed answered 500" });
    await db.insert(telegramLogin).values({ workspaceId, phone: "+10000000000" });
    await db.insert(telegramSession).values({ workspaceId, account: "Me (@me)", secretCiphertext: "ciphertext" });

    return { workspace: { id: workspaceId, name: "Morning coffee", ownerUserId: ownerId }, itemId };
  }

  /**
   * How many rows belong to that Workspace in each table. The child tables are counted through their
   * own foreign keys, not through `workspace_id`, because that is what the cascade does.
   */
  async function counts(ids: { workspace: { id: string; ownerUserId: string }; itemId: string }) {
    const { rows } = await db.$client.query<{ table: string; rows: number }>(
      `select 'workspace' as table, count(*)::int as rows from workspace where id = $1
        union all select 'source', count(*)::int from source where workspace_id = $1
        union all select 'item', count(*)::int from item where workspace_id = $1
        union all select 'item_log', count(*)::int from item_log where item_id = $2
        union all select 'item_category', count(*)::int from item_category where item_id = $2
        union all select 'item_field', count(*)::int from item_field where item_id = $2
        union all select 'classifier', count(*)::int from classifier where workspace_id = $1
        union all select 'extractor_rule', count(*)::int from extractor_rule where workspace_id = $1
        union all select 'correction', count(*)::int from correction where workspace_id = $1
        union all select 'profile', count(*)::int from profile where workspace_id = $1
        union all select 'model_config', count(*)::int from model_config where workspace_id = $1
        union all select 'agent_call', count(*)::int from agent_call where workspace_id = $1
        union all select 'destination', count(*)::int from destination where workspace_id = $1
        union all select 'health_alert_destination', count(*)::int from health_alert_destination where workspace_id = $1
        union all select 'action', count(*)::int from action where workspace_id = $1
        union all select 'action_destination', count(*)::int from action_destination
          where action_id in (select id from action where workspace_id = $1)
        union all select 'delivery', count(*)::int from delivery
          where action_id in (select id from action where workspace_id = $1)
        union all select 'digest_item', count(*)::int from digest_item
          where action_id in (select id from action where workspace_id = $1)
        union all select 'sent_message', count(*)::int from sent_message where workspace_id = $1
        union all select 'source_alert', count(*)::int from source_alert where workspace_id = $1
        union all select 'telegram_login', count(*)::int from telegram_login where workspace_id = $1
        union all select 'telegram_session', count(*)::int from telegram_session where workspace_id = $1
        union all select 'session', count(*)::int from session where user_id = $3
        union all select 'account', count(*)::int from account where user_id = $3`,
      [ids.workspace.id, ids.itemId, ids.workspace.ownerUserId],
    );
    return Object.fromEntries(rows.map((row) => [row.table, row.rows]));
  }

  /**
   * What the seed leaves in each table: the alert and the Digest are two rows, and each names the one
   * Destination, which is why their join table has two. Nothing is left after the delete.
   */
  const seeded = {
    workspace: 1,
    source: 1,
    item: 1,
    item_log: 1,
    item_category: 1,
    item_field: 1,
    classifier: 1,
    extractor_rule: 1,
    correction: 1,
    profile: 1,
    model_config: 1,
    agent_call: 1,
    destination: 1,
    health_alert_destination: 1,
    action: 2,
    action_destination: 2,
    delivery: 1,
    digest_item: 1,
    sent_message: 1,
    source_alert: 1,
    telegram_login: 1,
    telegram_session: 1,
    session: 1,
    account: 1,
  };
  const nothing = Object.fromEntries(Object.keys(seeded).map((table) => [table, 0]));

  it("deletes the account and every child row, after the pre-delete step has seen them", async () => {
    const ids = await seed();
    const before = await counts(ids);
    expect(before).toEqual(seeded);

    // The step runs inside the delete's transaction, before any row goes: this is where #314 reads
    // the Telegram session it has to log out.
    const seen: Record<string, number>[] = [];
    const beforeDelete = async ({ tx }: BeforeDelete) => {
      const [row] = await tx.select({ name: workspace.name }).from(workspace).where(eq(workspace.id, ids.workspace.id));
      seen.push(await counts(ids));
      expect(row).toEqual({ name: "Morning coffee" });
    };

    const outcome = await deleteWorkspace(
      db,
      { workspace: ids.workspace, typedName: "Morning coffee" },
      { encryptionKey: Buffer.alloc(32), boss, beforeDelete },
    );

    expect(outcome).toBe("deleted");
    expect(seen).toEqual([before]);
    expect(await counts(ids)).toEqual(nothing);
    expect(await db.select().from(user).where(eq(user.id, ids.workspace.ownerUserId))).toEqual([]);
  });

  it("deletes nothing when the typed name isn't the Workspace's", async () => {
    const ids = await seed();
    const before = await counts(ids);
    let stepped = false;

    const outcome = await deleteWorkspace(
      db,
      { workspace: ids.workspace, typedName: "Morning Coffee" },
      {
        encryptionKey: Buffer.alloc(32),
        boss,
        beforeDelete: () => {
          stepped = true;
          return Promise.resolve();
        },
      },
    );

    expect(outcome).toBe("wrong-name");
    expect(stepped).toBe(false);
    // Counted table by table, so a refusal that deleted a part of it would show.
    expect(await counts(ids)).toEqual(before);
    expect(await db.select().from(user).where(eq(user.id, ids.workspace.ownerUserId))).toHaveLength(1);
  });

  it("leaves the install unclaimed when the account was its admin, with /setup taking a claim again", async () => {
    const ids = await seed();
    await db.insert(instanceSettings).values({ adminUserId: ids.workspace.ownerUserId }).onConflictDoNothing();
    await db.update(instanceSettings).set({ adminUserId: ids.workspace.ownerUserId, setupTokenHash: null });

    expect(
      await deleteWorkspace(
        db,
        { workspace: ids.workspace, typedName: "Morning coffee" },
        { encryptionKey: Buffer.alloc(32), boss },
      ),
    ).toBe("deleted");

    const settings = await db.query.instanceSettings.findFirst();
    expect(settings).toMatchObject({ adminUserId: null });
    // Usable again: the next start issues a fresh setup link, and it claims the install.
    const url = await setupUrl("self-hosted", db, "http://localhost:3148");
    expect(url).toBeDefined();
    const token = new URL(present(url)).searchParams.get("token") ?? "";
    expect(await setupTokenValid(db, token)).toBe(true);
    expect(await afterDeletion(db, "self-hosted")).toBe("/setup");
  });

  it("sends the account to sign-in when the install still has its admin", async () => {
    const ids = await seed();
    const otherId = crypto.randomUUID();
    await db.insert(user).values({ id: otherId, name: "Other", email: `${otherId}@example.com` });
    await db.insert(instanceSettings).values({ adminUserId: otherId }).onConflictDoNothing();
    await db.update(instanceSettings).set({ adminUserId: otherId });

    await deleteWorkspace(
      db,
      { workspace: ids.workspace, typedName: "Morning coffee" },
      { encryptionKey: Buffer.alloc(32), boss },
    );

    expect(await afterDeletion(db, "self-hosted")).toBe("/sign-in");
    expect(await afterDeletion(db, "hosted")).toBe("/sign-in");
  });

  it("counts a row only inside its own Workspace, so a second one keeps all of its own", async () => {
    const gone = await seed();
    const kept = await seed();

    await deleteWorkspace(
      db,
      { workspace: gone.workspace, typedName: "Morning coffee" },
      { encryptionKey: Buffer.alloc(32), boss },
    );

    expect(await counts(gone)).toEqual(nothing);
    expect(await counts(kept)).toEqual(seeded);
    // The other Workspace's Log row is still there, which says the cascade is scoped by the rows' own keys.
    expect(
      await db.select({ id: itemLog.id }).from(itemLog).where(eq(itemLog.itemId, kept.itemId)),
    ).toHaveLength(1);
  });
});
