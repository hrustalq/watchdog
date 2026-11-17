// Deleting one Workspace, and deleting the account that owns them all (docs: Security and privacy,
// "Deleting and exporting a Workspace"): the rows go through the cascade chain, the pre-delete step
// sees each Workspace's Telegram session while it is still there, and a self-hosted install whose
// admin went is unclaimed again.
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
  sql,
  telegramLogin,
  telegramSession,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { telegramRevokeQueue } from "@watchdog/core";
import { PgBoss } from "pg-boss";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTokenValid, setupUrl } from "./instance.ts";
import {
  afterDeletion,
  type BeforeDelete,
  deleteAccount,
  deleteWorkspace,
  logoutTelegramSession,
} from "./workspace-deletion.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

describe("deleting a Workspace", () => {
  let db: Db;
  let boss: PgBoss;

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    // The web app only sends jobs; nothing works them here, so a test reads what it queued.
    boss = new PgBoss(postgres.url);
    await boss.start();
    await boss.createQueue(telegramRevokeQueue);
    return async () => {
      await boss.stop({ timeout: 1_000 });
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** What the delete queued for the worker: the encrypted session of a Workspace that just went. */
  const queued = async () =>
    (
      await db.execute<{ data: { secretCiphertext: string } }>(
        sql`select data from pgboss.job where name = ${telegramRevokeQueue}`,
      )
    ).rows.map((row) => row.data);

  /** The queue the web app sends on: here nothing works it, so a test reads what the delete queued. */
  const sender = () => Promise.resolve(boss);

  beforeEach(async () => {
    await db.execute(sql`delete from pgboss.job where name = ${telegramRevokeQueue}`);
  });

  /** An account, which owns every Workspace the test makes for it. */
  async function anAccount() {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    await db.insert(session).values({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      userId: id,
    });
    await db.insert(account).values({ id: crypto.randomUUID(), accountId: id, providerId: "credential", userId: id });
    return { id, email: `${id}@example.com` };
  }

  /** A Workspace with a row in every table that belongs to one, and the ids the counts read by. */
  async function seed(ownerId: string, name = "Morning coffee") {
    const [ws] = await db.insert(workspace).values({ name, ownerUserId: ownerId }).returning();
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
      .values({
        workspaceId,
        name: "ones",
        kind: "alert",
        definition: { action: "ones", when, kind: "alert", destinations: [destinationId] },
      })
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
    await db.insert(telegramLogin).values({ workspaceId, phone: "+100****0000" });
    await db.insert(telegramSession).values({ workspaceId, account: "Me (@me)", secretCiphertext: "ciphertext" });

    return { workspace: { id: workspaceId, name, ownerUserId: ownerId }, itemId };
  }

  /**
   * How many rows belong to that Workspace in each table. The child tables are counted through their
   * own foreign keys, not through `workspace_id`, because that is what the cascade does.
   */
  async function counts(ids: { workspace: { id: string }; itemId: string }) {
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
        union all select 'telegram_session', count(*)::int from telegram_session where workspace_id = $1`,
      [ids.workspace.id, ids.itemId],
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
  };
  const nothing = Object.fromEntries(Object.keys(seeded).map((table) => [table, 0]));

  it("deletes the Workspace and every child row, and leaves the account signed in", async () => {
    const owner = await anAccount();
    // The account has a second Workspace, or deleting this one would be its last and refused.
    const kept = await seed(owner.id, "Markets");
    const ids = await seed(owner.id);
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
      { encryptionKey: Buffer.alloc(32), boss: sender, beforeDelete },
    );

    expect(outcome).toBe("deleted");
    expect(seen).toEqual([before]);
    expect(await counts(ids)).toEqual(nothing);
    // The account itself stays, with its other Workspace and its session.
    expect(await db.select().from(user).where(eq(user.id, owner.id))).toHaveLength(1);
    expect(await counts(kept)).toEqual(seeded);
  });

  it("queues the Workspace's Telegram session logout with its secret, before the row cascades away", async () => {
    const owner = await anAccount();
    await seed(owner.id, "Markets");
    const ids = await seed(owner.id);

    expect(
      await deleteWorkspace(
        db,
        { workspace: ids.workspace, typedName: "Morning coffee" },
        { encryptionKey: Buffer.alloc(32), boss: sender, beforeDelete: logoutTelegramSession },
      ),
    ).toBe("deleted");

    // The frame the delete was after: the row it would have read is gone, so the job carries the
    // encrypted secret, and the worker logs the session out from that.
    expect(await counts(ids)).toEqual(nothing);
    expect(await queued()).toEqual([{ secretCiphertext: "ciphertext" }]);
  });

  it("queues no logout for a Workspace with no session, or one nobody can read", async () => {
    const owner = await anAccount();
    await seed(owner.id, "Markets");
    const none = await seed(owner.id);
    await db.delete(telegramSession).where(eq(telegramSession.workspaceId, none.workspace.id));
    await deleteWorkspace(
      db,
      { workspace: none.workspace, typedName: "Morning coffee" },
      { encryptionKey: Buffer.alloc(32), boss: sender, beforeDelete: logoutTelegramSession },
    );
    expect(await queued()).toEqual([]);

    // A session stored under another WATCHDOG_ENCRYPTION_KEY: no retry could log it out, so the
    // delete queues nothing rather than a job that can only fail.
    const unreadable = await seed(owner.id);
    await db
      .update(telegramSession)
      .set({ unreadableAt: new Date() })
      .where(eq(telegramSession.workspaceId, unreadable.workspace.id));
    expect(
      await deleteWorkspace(
        db,
        { workspace: unreadable.workspace, typedName: "Morning coffee" },
        { encryptionKey: Buffer.alloc(32), boss: sender, beforeDelete: logoutTelegramSession },
      ),
    ).toBe("deleted");
    expect(await queued()).toEqual([]);
  });

  it("deletes nothing when the typed name isn't the Workspace's", async () => {
    const owner = await anAccount();
    await seed(owner.id, "Markets");
    const ids = await seed(owner.id);
    const before = await counts(ids);
    let stepped = false;

    const outcome = await deleteWorkspace(
      db,
      { workspace: ids.workspace, typedName: "Morning Coffee" },
      {
        encryptionKey: Buffer.alloc(32),
        boss: sender,
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
  });

  it("refuses the account's last Workspace, which needs account deletion instead", async () => {
    const owner = await anAccount();
    const only = await seed(owner.id);
    const before = await counts(only);
    let stepped = false;

    const outcome = await deleteWorkspace(
      db,
      { workspace: only.workspace, typedName: "Morning coffee" },
      {
        encryptionKey: Buffer.alloc(32),
        boss: sender,
        beforeDelete: () => {
          stepped = true;
          return Promise.resolve();
        },
      },
    );

    expect(outcome).toBe("last-one");
    expect(stepped).toBe(false);
    expect(await counts(only)).toEqual(before);
    expect(await db.select().from(user).where(eq(user.id, owner.id))).toHaveLength(1);
  });

  it("counts a row only inside its own Workspace, so a second account keeps all of its own", async () => {
    const mine = await anAccount();
    await seed(mine.id, "Markets");
    const gone = await seed(mine.id);
    const theirs = await seed((await anAccount()).id);

    await deleteWorkspace(
      db,
      { workspace: gone.workspace, typedName: "Morning coffee" },
      { encryptionKey: Buffer.alloc(32), boss: sender },
    );

    expect(await counts(gone)).toEqual(nothing);
    expect(await counts(theirs)).toEqual(seeded);
    // The other Workspace's Log row is still there, which says the cascade is scoped by the rows' own keys.
    expect(await db.select({ id: itemLog.id }).from(itemLog).where(eq(itemLog.itemId, theirs.itemId))).toHaveLength(1);
  });
});

describe("deleting the account", () => {
  let db: Db;
  let boss: PgBoss;

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    boss = new PgBoss(postgres.url);
    await boss.start();
    await boss.createQueue(telegramRevokeQueue);
    return async () => {
      await boss.stop({ timeout: 1_000 });
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  const sender = () => Promise.resolve(boss);

  const accountWith = async (names: string[]) => {
    const id = crypto.randomUUID();
    const email = `${id}@example.com`;
    await db.insert(user).values({ id, name: "Owner", email });
    await db.insert(session).values({
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      userId: id,
    });
    for (const name of names) {
      const [row] = await db.insert(workspace).values({ name, ownerUserId: id }).returning();
      await db.insert(telegramSession).values({
        workspaceId: present(row).id,
        account: "Me (@me)",
        secretCiphertext: `ciphertext-${name}`,
      });
    }
    return { id, email };
  };

  it("removes the user, every Workspace it owns, and runs the pre-delete step once for each", async () => {
    const owner = await accountWith(["Work", "Markets"]);
    const stepped: string[] = [];

    expect(
      await deleteAccount(
        db,
        { user: owner, typedEmail: owner.email },
        {
          encryptionKey: Buffer.alloc(32),
          boss: sender,
          beforeDelete: async ({ workspace: one }) => {
            stepped.push(one.name);
          },
        },
      ),
    ).toBe("deleted");

    expect(stepped.sort()).toEqual(["Markets", "Work"]);
    expect(await db.select().from(workspace).where(eq(workspace.ownerUserId, owner.id))).toEqual([]);
    expect(await db.select().from(user).where(eq(user.id, owner.id))).toEqual([]);
    expect(await db.select().from(session).where(eq(session.userId, owner.id))).toEqual([]);
  });

  it("deletes nothing when the typed email isn't the account's", async () => {
    const owner = await accountWith(["Work"]);

    expect(
      await deleteAccount(
        db,
        { user: owner, typedEmail: "someone@example.com" },
        { encryptionKey: Buffer.alloc(32), boss: sender },
      ),
    ).toBe("wrong-email");
    expect(await db.select().from(user).where(eq(user.id, owner.id))).toHaveLength(1);
    expect(await db.select().from(workspace).where(eq(workspace.ownerUserId, owner.id))).toHaveLength(1);
  });

  it("leaves the install unclaimed when the account was its admin, with /setup taking a claim again", async () => {
    const owner = await accountWith(["Work"]);
    await db.insert(instanceSettings).values({ adminUserId: owner.id }).onConflictDoNothing();
    await db.update(instanceSettings).set({ adminUserId: owner.id, setupTokenHash: null });

    expect(
      await deleteAccount(db, { user: owner, typedEmail: owner.email }, { encryptionKey: Buffer.alloc(32), boss: sender }),
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
    const owner = await accountWith(["Work"]);
    const otherId = crypto.randomUUID();
    await db.insert(user).values({ id: otherId, name: "Other", email: `${otherId}@example.com` });
    await db.insert(instanceSettings).values({ adminUserId: otherId }).onConflictDoNothing();
    await db.update(instanceSettings).set({ adminUserId: otherId });

    await deleteAccount(db, { user: owner, typedEmail: owner.email }, { encryptionKey: Buffer.alloc(32), boss: sender });

    expect(await afterDeletion(db, "self-hosted")).toBe("/sign-in");
    expect(await afterDeletion(db, "hosted")).toBe("/sign-in");
  });
});
