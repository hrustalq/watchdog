import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "./client.ts";
import { migrate } from "./migrate.ts";
import {
  action,
  actionDestination,
  delivery,
  destination,
  digestItem,
  item,
  itemLog,
  source,
  telegramLinkCode,
  user,
  workspace,
} from "./schema/index.ts";
import { migrateFirst, startPostgres, type TestPostgres } from "./testing/postgres.ts";

/** The one row a query returned. */
function only<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length > 1) throw new Error(`Expected one row, got ${String(rows.length)}`);
  return row;
}

/** A user with a Workspace, one RSS Source and one Item. */
async function seed(db: Db) {
  const id = crypto.randomUUID();
  const owner = only(
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` }).returning(),
  );
  const ws = only(
    await db.insert(workspace).values({ name: "Workspace", ownerUserId: owner.id }).returning(),
  );
  const src = only(
    await db
      .insert(source)
      .values({
        workspaceId: ws.id,
        type: "rss",
        name: "Blog",
        config: { url: "https://example.com/feed.xml" },
        schedule: "*/15 * * * *",
      })
      .returning(),
  );
  const captured = only(
    await db
      .insert(item)
      .values({ workspaceId: ws.id, sourceId: src.id, externalId: "guid-1", body: "Hello", raw: {} })
      .returning(),
  );
  return { owner, workspace: ws, source: src, item: captured };
}

/** A seeded Workspace with a row in every table this issue adds. */
async function seedEverything(db: Db) {
  const seeded = await seed(db);
  const workspaceId = seeded.workspace.id;
  const itemId = seeded.item.id;
  const chat = only(
    await db
      .insert(destination)
      .values({ workspaceId, type: "telegram", name: "ops-chat", secretCiphertext: "v1.chat" })
      .returning(),
  );
  const mail = only(
    await db
      .insert(destination)
      .values({ workspaceId, type: "email", name: "me", config: { address: "me@example.com" } })
      .returning(),
  );
  const hook = only(
    await db
      .insert(destination)
      .values({
        workspaceId,
        type: "webhook",
        name: "crm-inbox",
        config: { url: "https://crm.example.com/inbox" },
        secretCiphertext: "v1.secret",
        confirmedAt: new Date(),
      })
      .returning(),
  );
  const alert = only(
    await db.insert(action).values({ workspaceId, name: "sev-alert", kind: "alert", definition: {} }).returning(),
  );
  const digest = only(
    await db.insert(action).values({ workspaceId, name: "weekly", kind: "digest", definition: {} }).returning(),
  );
  await db.insert(actionDestination).values([
    { actionId: alert.id, destinationId: chat.id },
    { actionId: digest.id, destinationId: mail.id },
  ]);
  const sent = only(
    await db
      .insert(delivery)
      .values({ actionId: alert.id, itemId, destinationId: chat.id, status: "sent", sentAt: new Date() })
      .returning(),
  );
  await db.insert(digestItem).values({ actionId: digest.id, itemId });
  await db.insert(telegramLinkCode).values({
    codeHash: `hash-${chat.id}`,
    destinationId: chat.id,
    expiresAt: new Date(Date.now() + 600_000),
  });
  await db.insert(itemLog).values({ itemId, stage: "act", message: "sev-alert fired to ops-chat" });
  return { ...seeded, chat, mail, hook, alert, digest, delivery: sent };
}

describe("Destination, Action and Delivery tables", () => {
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

  it("inserts a row in every new table, with the defaults", async () => {
    const seeded = await seedEverything(db);

    expect(seeded.chat).toMatchObject({ config: {}, confirmedAt: null, lastError: null, lastErrorAt: null });
    expect(seeded.alert).toMatchObject({ enabled: true, definition: {} });
    expect(seeded.delivery).toMatchObject({ attempts: 0, nextAttemptAt: null, lastError: null });
    const queued = only(
      await db
        .insert(delivery)
        .values({ actionId: seeded.alert.id, itemId: seeded.item.id, destinationId: seeded.mail.id })
        .returning(),
    );
    expect(queued.status).toBe("queued");
  });

  it("refuses a second delivery for the same Action, Item and Destination", async () => {
    const seeded = await seedEverything(db);

    await expect(
      db
        .insert(delivery)
        .values({ actionId: seeded.alert.id, itemId: seeded.item.id, destinationId: seeded.chat.id }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "delivery_action_id_item_id_destination_id_key" } });
  });

  it("refuses to delete a Destination that a delivery or an action_destination row points at", async () => {
    const seeded = await seedEverything(db);

    // The Telegram chat has both. Remove the Action's reference, and the delivery still holds it.
    await expect(db.delete(destination).where(eq(destination.id, seeded.chat.id))).rejects.toMatchObject({
      cause: { code: "23503" },
    });
    await db.delete(actionDestination).where(eq(actionDestination.destinationId, seeded.chat.id));
    await expect(db.delete(destination).where(eq(destination.id, seeded.chat.id))).rejects.toMatchObject({
      cause: { code: "23503", constraint: "delivery_destination_id_destination_id_fk" },
    });
    // The mailbox only has an Action pointing at it.
    await expect(db.delete(destination).where(eq(destination.id, seeded.mail.id))).rejects.toMatchObject({
      cause: { code: "23503", constraint: "action_destination_destination_id_destination_id_fk" },
    });
    // Nothing points at the webhook, so it goes.
    await db.delete(destination).where(eq(destination.id, seeded.hook.id));
    expect(await db.select().from(destination).where(eq(destination.id, seeded.hook.id))).toEqual([]);
  });

  it("deleting an Item or an Action takes their deliveries and digest_item rows with them", async () => {
    const byItem = await seedEverything(db);
    await db.delete(item).where(eq(item.id, byItem.item.id));
    expect(await db.select().from(delivery).where(eq(delivery.actionId, byItem.alert.id))).toEqual([]);
    expect(await db.select().from(digestItem).where(eq(digestItem.actionId, byItem.digest.id))).toEqual([]);

    const byAction = await seedEverything(db);
    await db.delete(action).where(eq(action.id, byAction.alert.id));
    await db.delete(action).where(eq(action.id, byAction.digest.id));
    expect(await db.select().from(delivery).where(eq(delivery.itemId, byAction.item.id))).toEqual([]);
    expect(await db.select().from(digestItem).where(eq(digestItem.itemId, byAction.item.id))).toEqual([]);
    expect(await db.select().from(actionDestination).where(eq(actionDestination.destinationId, byAction.chat.id))).toEqual([]);
    // The Destinations and their link codes stay.
    expect(await db.select().from(telegramLinkCode).where(eq(telegramLinkCode.destinationId, byAction.chat.id))).toHaveLength(1);
  });

  it("deleting a Destination takes its link codes, and a user takes everything through the Workspace", async () => {
    const kept = await seedEverything(db);
    const gone = await seedEverything(db);

    await db.delete(destination).where(eq(destination.id, gone.hook.id));
    await db.delete(user).where(eq(user.id, gone.owner.id));

    const workspaceId = gone.workspace.id;
    expect(await db.select().from(destination).where(eq(destination.workspaceId, workspaceId))).toEqual([]);
    expect(await db.select().from(action).where(eq(action.workspaceId, workspaceId))).toEqual([]);
    expect(await db.select().from(delivery).where(eq(delivery.itemId, gone.item.id))).toEqual([]);
    expect(await db.select().from(telegramLinkCode).where(eq(telegramLinkCode.destinationId, gone.chat.id))).toEqual([]);
    expect(await db.select().from(destination).where(eq(destination.workspaceId, kept.workspace.id))).toHaveLength(3);
  });

  it("keeps Destination and Action names unique per Workspace", async () => {
    const seeded = await seedEverything(db);
    const other = await seed(db);

    await expect(
      db.insert(destination).values({ workspaceId: seeded.workspace.id, type: "email", name: "me" }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "destination_workspace_id_name_key" } });
    await expect(
      db.insert(action).values({ workspaceId: seeded.workspace.id, name: "weekly", kind: "alert", definition: {} }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "action_workspace_id_name_key" } });

    await db.insert(destination).values({ workspaceId: other.workspace.id, type: "email", name: "me" });
    await db.insert(action).values({ workspaceId: other.workspace.id, name: "weekly", kind: "alert", definition: {} });
  });

  it("accepts act in an Item's Log", async () => {
    const seeded = await seed(db);

    await db.insert(itemLog).values({ itemId: seeded.item.id, stage: "act", message: "No Action matched" });

    const rows = await db.select().from(itemLog).where(eq(itemLog.itemId, seeded.item.id));
    expect(rows.map((row) => row.stage)).toEqual(["act"]);
  });

  it.each([
    ["destination", "type", "destination_type_check"],
    ["action", "kind", "action_kind_check"],
    ["delivery", "status", "delivery_status_check"],
  ])("refuses an unknown %s.%s by a check", async (table, column, constraint) => {
    await seedEverything(db);

    await expect(
      db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = 'unknown'`),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint } });
  });

  it("gives a Workspace its alert settings' defaults and keeps quiet hours a pair", async () => {
    const seeded = await seed(db);

    expect(seeded.workspace).toMatchObject({
      timezone: "UTC",
      quietHoursStart: null,
      quietHoursEnd: null,
      severity5BypassesQuietHours: false,
      alertsPerHour: 20,
      burstWindowSeconds: 60,
    });

    const quiet = only(
      await db
        .update(workspace)
        .set({ timezone: "Europe/Berlin", quietHoursStart: "22:00", quietHoursEnd: "07:30" })
        .where(eq(workspace.id, seeded.workspace.id))
        .returning(),
    );
    expect(quiet).toMatchObject({ quietHoursStart: "22:00:00", quietHoursEnd: "07:30:00" });
    await expect(
      db.update(workspace).set({ quietHoursEnd: null }).where(eq(workspace.id, seeded.workspace.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "workspace_quiet_hours_check" } });
    await expect(
      db.update(workspace).set({ alertsPerHour: 0 }).where(eq(workspace.id, seeded.workspace.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "workspace_alerts_per_hour_check" } });
    await expect(
      db.update(workspace).set({ burstWindowSeconds: -1 }).where(eq(workspace.id, seeded.workspace.id)),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint: "workspace_burst_window_seconds_check" } });
  });

  it("loads the new rows through the relations", async () => {
    const seeded = await seedEverything(db);

    const loaded = await db.query.workspace.findFirst({
      where: eq(workspace.id, seeded.workspace.id),
      with: {
        destinations: true,
        actions: {
          with: { actionDestinations: { with: { destination: true } }, deliveries: true, digestItems: true },
        },
        items: { with: { deliveries: { with: { destination: true } } } },
      },
    });

    expect(loaded?.destinations).toHaveLength(3);
    expect(
      loaded?.actions.flatMap((row) => row.actionDestinations).map((row) => row.destination.name).sort(),
    ).toEqual(["me", "ops-chat"]);
    expect(loaded?.actions.flatMap((row) => row.deliveries)).toHaveLength(1);
    expect(loaded?.actions.flatMap((row) => row.digestItems)).toHaveLength(1);
    expect(loaded?.items[0]?.deliveries[0]?.destination.name).toBe("ops-chat");
  });

  it("applies migration 0009 on a database at 0008 holding M2 data", async () => {
    await db.execute(sql`create database at_0008`);
    const url = new URL(postgres.url);
    url.pathname = "/at_0008";
    await migrateFirst(url.href, 9);
    const old = createDb(url.href);
    try {
      await old.execute(sql`insert into "user" (id, name, email) values ('u', 'O', 'o@example.com')`);
      await old.execute(sql`insert into workspace (name, owner_user_id) values ('Workspace', 'u')`);
      await old.execute(sql`
        insert into source (workspace_id, type, name, config, schedule)
        select id, 'rss', 'Blog', '{"url": "https://example.com/feed.xml"}', '*/15 * * * *' from workspace`);
      await old.execute(sql`
        insert into item (workspace_id, source_id, external_id, body, raw, severity, importance)
        select workspace_id, id, 'guid-1', 'Hello', '{}', 4, 3 from source`);
      await old.execute(sql`insert into item_log (item_id, stage, message) select id, 'rate', 'Rated' from item`);
    } finally {
      await closeDb(old);
    }

    await migrate(url.href);

    const upgraded = createDb(url.href);
    try {
      const ws = only(await upgraded.select().from(workspace));
      expect(ws).toMatchObject({ timezone: "UTC", quietHoursStart: null, alertsPerHour: 20, burstWindowSeconds: 60 });
      const kept = only(await upgraded.select().from(item));
      expect(kept).toMatchObject({ externalId: "guid-1", severity: 4, importance: 3, topScore: 10 });
      await upgraded.insert(itemLog).values({ itemId: kept.id, stage: "act", message: "No Action matched" });
      await upgraded.insert(destination).values({ workspaceId: ws.id, type: "email", name: "me" });
    } finally {
      await closeDb(upgraded);
    }
  }, 60_000);
});
