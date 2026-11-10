import { deliver, type DeliverDeps } from "@watchdog/core";
import {
  action,
  actionDestination,
  closeDb,
  createDb,
  type Db,
  delivery,
  destination,
  eq,
  healthAlertDestination,
  item,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AlertSettingsForm,
  loadAlertSettings,
  loadHealthAlertDestinations,
  quietHoursSentence,
  saveAlertSettings,
  saveHealthAlertDestinations,
} from "./settings.ts";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const form = (values: Partial<AlertSettingsForm> = {}): AlertSettingsForm => ({
  timezone: "UTC",
  quietHours: false,
  quietHoursStart: "",
  quietHoursEnd: "",
  severity5Bypasses: false,
  alertsPerHour: "20",
  burstWindowSeconds: "60",
  ...values,
});

describe("the Settings screen's alert settings", () => {
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

  async function newWorkspace() {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    const [row] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: id }).returning();
    return present(row).id;
  }

  /** A confirmed Telegram Destination with an alert Action on it, and a way to queue a Delivery to it. */
  async function alerting(workspaceId: string) {
    const [src] = await db
      .insert(source)
      .values({ workspaceId, type: "rss", name: "Feed", config: { url: "https://feeds.test/a.rss" }, schedule: "*/15 * * * *" })
      .returning();
    const [chat] = await db
      .insert(destination)
      .values({ workspaceId, type: "telegram", name: "ops-chat", confirmedAt: new Date() })
      .returning();
    const destinationId = present(chat).id;
    const when = { field: "severity", op: "gte", value: 4 };
    const [saved] = await db
      .insert(action)
      .values({
        workspaceId,
        name: "critical",
        kind: "alert",
        definition: { action: "critical", when, kind: "alert", destinations: [destinationId] },
      })
      .returning();
    const actionId = present(saved).id;
    await db.insert(actionDestination).values({ actionId, destinationId });
    return async (severity: number) => {
      const [captured] = await db
        .insert(item)
        .values({
          workspaceId,
          sourceId: present(src).id,
          externalId: crypto.randomUUID(),
          title: "An advisory",
          body: "An entry.",
          raw: {},
          severity,
          importance: 3,
        })
        .returning();
      const [row] = await db
        .insert(delivery)
        .values({ actionId, itemId: present(captured).id, destinationId })
        .returning();
      return present(row).id;
    };
  }

  function recording(now: Date) {
    const sent: unknown[] = [];
    const sender = {
      send: (_target: unknown, message: unknown) => {
        sent.push(message);
        return Promise.resolve();
      },
    };
    const deps: DeliverDeps = {
      senders: { telegram: sender, email: sender, webhook: sender },
      appUrl: "https://watchdog.test",
      retryDelivery: () => Promise.resolve(),
      now: () => now,
    };
    return { sent, deps };
  }

  const statusOf = async (deliveryId: string) =>
    (await db.query.delivery.findFirst({ where: eq(delivery.id, deliveryId) }))?.status;

  it("starts at the documented defaults", async () => {
    const workspaceId = await newWorkspace();

    expect(await loadAlertSettings(db, workspaceId)).toEqual({
      timezone: "UTC",
      quietHoursStart: null,
      quietHoursEnd: null,
      severity5BypassesQuietHours: false,
      alertsPerHour: 20,
      burstWindowSeconds: 60,
    });
  });

  it("saves Europe/Moscow 22:00 to 07:00, says so, and holds a Severity 4 alert sent at 23:00 Moscow time", async () => {
    const workspaceId = await newWorkspace();
    const queue = await alerting(workspaceId);

    const result = await saveAlertSettings(
      db,
      workspaceId,
      form({ timezone: "Europe/Moscow", quietHours: true, quietHoursStart: "22:00", quietHoursEnd: "07:00" }),
    );

    expect(result).toEqual({ saved: true });
    expect(quietHoursSentence(await loadAlertSettings(db, workspaceId))).toBe(
      "Alerts are held from 22:00 to 07:00 Europe/Moscow.",
    );
    // 23:00 in Moscow, which is UTC+3 all year.
    const { deps, sent } = recording(new Date("2099-01-07T20:00:00Z"));
    const deliveryId = await queue(4);
    await deliver(db, deliveryId, deps);
    expect(sent).toEqual([]);
    expect(await db.query.delivery.findFirst({ where: eq(delivery.id, deliveryId) })).toMatchObject({
      status: "held",
      nextAttemptAt: new Date("2099-01-08T04:00:00Z"),
    });
  });

  it("refuses Mars/Olympus and 25:00 beside their fields and changes nothing", async () => {
    const workspaceId = await newWorkspace();
    const before = await loadAlertSettings(db, workspaceId);

    const result = await saveAlertSettings(
      db,
      workspaceId,
      form({ timezone: "Mars/Olympus", quietHours: true, quietHoursStart: "25:00", quietHoursEnd: "07:00" }),
    );

    expect("errors" in result && Object.keys(result.errors).sort()).toEqual(["quietHoursStart", "timezone"]);
    expect(await loadAlertSettings(db, workspaceId)).toEqual(before);
  });

  it("sends 25 alerts in a minute as 25 messages at a burst window of 0 and 25 alerts an hour", async () => {
    const workspaceId = await newWorkspace();
    const queue = await alerting(workspaceId);
    await saveAlertSettings(db, workspaceId, form({ burstWindowSeconds: "0", alertsPerHour: "25" }));

    const { deps, sent } = recording(new Date("2099-01-07T12:00:30Z"));
    const ids = [];
    for (let index = 0; index < 25; index++) ids.push(await queue(4));
    for (const id of ids) await deliver(db, id, deps);

    expect(sent).toHaveLength(25);
    expect(await Promise.all(ids.map(statusOf))).toEqual(ids.map(() => "sent"));
  });

  it("holds the last 5 of those 25 at the default of 20 an hour", async () => {
    const workspaceId = await newWorkspace();
    const queue = await alerting(workspaceId);
    await saveAlertSettings(db, workspaceId, form({ burstWindowSeconds: "0" }));

    const { deps, sent } = recording(new Date("2099-01-07T12:00:30Z"));
    const ids = [];
    for (let index = 0; index < 25; index++) ids.push(await queue(4));
    for (const id of ids) await deliver(db, id, deps);

    expect(sent).toHaveLength(20);
    expect((await Promise.all(ids.map(statusOf))).filter((status) => status === "held")).toHaveLength(5);
  });

  it("turns quiet hours off again", async () => {
    const workspaceId = await newWorkspace();
    await saveAlertSettings(db, workspaceId, form({ quietHours: true, quietHoursStart: "22:00", quietHoursEnd: "07:00" }));

    await saveAlertSettings(db, workspaceId, form({ quietHours: false, quietHoursStart: "22:00", quietHoursEnd: "07:00" }));

    expect(await loadAlertSettings(db, workspaceId)).toMatchObject({ quietHoursStart: null, quietHoursEnd: null });
  });

  describe("the Health alerts setting", () => {
    const add = async (workspaceId: string, values: Partial<typeof destination.$inferInsert> & { name: string }) => {
      const [row] = await db
        .insert(destination)
        .values({ workspaceId, type: "telegram", confirmedAt: new Date(), ...values })
        .returning();
      return present(row).id;
    };

    it("offers the confirmed Telegram chats and email addresses, by name, and none is named at first", async () => {
      const workspaceId = await newWorkspace();
      const chat = await add(workspaceId, { name: "ops-chat" });
      const inbox = await add(workspaceId, { name: "Team inbox", type: "email", config: { address: "team@example.com" } });
      await add(workspaceId, { name: "Waiting", type: "email", config: { address: "new@example.com" }, confirmedAt: null });
      await add(workspaceId, { name: "A hook", type: "webhook", config: { url: "https://hooks.example.com" } });
      await add(await newWorkspace(), { name: "Someone else's chat" });

      expect(await loadHealthAlertDestinations(db, workspaceId)).toEqual([
        { id: inbox, name: "Team inbox", type: "email", named: false },
        { id: chat, name: "ops-chat", type: "telegram", named: false },
      ]);
    });

    it("names the ticked Destinations, and a later save replaces them", async () => {
      const workspaceId = await newWorkspace();
      const chat = await add(workspaceId, { name: "ops-chat" });
      const inbox = await add(workspaceId, { name: "Team inbox", type: "email", config: { address: "team@example.com" } });
      const named = async () =>
        (await loadHealthAlertDestinations(db, workspaceId)).filter((option) => option.named).map(({ id }) => id);

      await saveHealthAlertDestinations(db, workspaceId, [chat, inbox]);
      expect((await named()).sort()).toEqual([chat, inbox].sort());

      await saveHealthAlertDestinations(db, workspaceId, [inbox]);
      expect(await named()).toEqual([inbox]);

      // None ticked: the alerts go back to the sign-in address.
      await saveHealthAlertDestinations(db, workspaceId, []);
      expect(await named()).toEqual([]);
    });

    it("ignores what a crafted form posts: another Workspace's, an unconfirmed one, a webhook, not an id", async () => {
      const workspaceId = await newWorkspace();
      const chat = await add(workspaceId, { name: "ops-chat" });
      const waiting = await add(workspaceId, { name: "Waiting", type: "email", config: { address: "new@example.com" }, confirmedAt: null });
      const hook = await add(workspaceId, { name: "A hook", type: "webhook", config: { url: "https://hooks.example.com" } });
      const theirs = await add(await newWorkspace(), { name: "Someone else's chat" });

      await saveHealthAlertDestinations(db, workspaceId, [theirs, waiting, hook, "not-an-id", chat, chat]);

      expect(await db.select().from(healthAlertDestination).where(eq(healthAlertDestination.workspaceId, workspaceId))).toEqual([
        { workspaceId, destinationId: chat },
      ]);
      expect(await db.select().from(healthAlertDestination).where(eq(healthAlertDestination.destinationId, theirs))).toEqual([]);
    });
  });
});
