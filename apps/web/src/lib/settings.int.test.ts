import { deliver, type DeliverDeps, type EmailCap, releaseDueDeliveries } from "@watchdog/core";
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
  itemLog,
  migrate,
  sentMessage,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AlertSettingsForm,
  changesHolds,
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

  /** A confirmed Destination, Telegram unless the test says email, with an alert Action on it and a way to queue a Delivery to it. */
  async function alerting(workspaceId: string, type: "telegram" | "email" = "telegram") {
    const [src] = await db
      .insert(source)
      .values({ workspaceId, type: "rss", name: "Feed", config: { url: "https://feeds.test/a.rss" }, schedule: "*/15 * * * *" })
      .returning();
    const [chat] = await db
      .insert(destination)
      .values({
        workspaceId,
        type,
        name: type === "telegram" ? "ops-chat" : "me",
        confirmedAt: new Date(),
        ...(type === "email" && { config: { address: "me@example.com" } }),
      })
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
    const queue = async (severity: number) => {
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
    return { queue, destinationId };
  }

  function recording(now: Date, emailCap?: EmailCap) {
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
      ...(emailCap !== undefined && { emailCap }),
    };
    return { sent, deps };
  }

  const statusOf = async (deliveryId: string) =>
    (await db.query.delivery.findFirst({ where: eq(delivery.id, deliveryId) }))?.status;

  const rowOf = async (deliveryId: string) =>
    present(await db.query.delivery.findFirst({ where: eq(delivery.id, deliveryId) }));

  const logOf = async (deliveryId: string) =>
    (await db.select().from(itemLog).where(eq(itemLog.itemId, (await rowOf(deliveryId)).itemId)).orderBy(itemLog.id)).map(
      (row) => row.message,
    );

  /** Due at the next sweep, rather than at a time a setting set before the save. */
  const dueNow = (row: { nextAttemptAt: Date | null }) => {
    expect(row.nextAttemptAt?.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  };

  /** What the worker's sweep does when a held row's time has come: it is queued again, and its job runs. */
  const sweep = () =>
    db.transaction(async (tx) => {
      await releaseDueDeliveries(tx);
    });

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
    const { queue } = await alerting(workspaceId);

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
    const { queue } = await alerting(workspaceId);
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
    const { queue } = await alerting(workspaceId);
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

  describe("releasing what a save loosens", () => {
    const quiet = (values: Partial<AlertSettingsForm> = {}) =>
      form({ timezone: "Europe/Moscow", quietHours: true, quietHoursStart: "22:00", quietHoursEnd: "07:00", ...values });

    it("counts a save as changing the settings only when one that times a hold changes", async () => {
      const workspaceId = await newWorkspace();
      await saveAlertSettings(db, workspaceId, quiet());
      // As Postgres writes it back: the times carry seconds, which the form never posts.
      const saved = await loadAlertSettings(db, workspaceId);

      expect(changesHolds(saved, saved)).toBe(false);
      expect(changesHolds(saved, { ...saved, timezone: "UTC" })).toBe(true);
      expect(changesHolds(saved, { ...saved, quietHoursStart: null, quietHoursEnd: null })).toBe(true);
      expect(changesHolds(saved, { ...saved, quietHoursEnd: "06:00" })).toBe(true);
      expect(changesHolds(saved, { ...saved, severity5BypassesQuietHours: true })).toBe(true);
      expect(changesHolds(saved, { ...saved, alertsPerHour: 21 })).toBe(true);
      expect(changesHolds(saved, { ...saved, burstWindowSeconds: 61 })).toBe(true);
    });

    it("sends a Severity 4 alert held until 07:00 within a minute of quiet hours being turned off at 23:00", async () => {
      const workspaceId = await newWorkspace();
      const { queue } = await alerting(workspaceId);
      await saveAlertSettings(db, workspaceId, quiet());

      // 23:00 in Moscow, which is UTC+3 all year, so the alert waits for 07:00 local time.
      const { deps, sent } = recording(new Date("2099-01-07T20:00:00Z"));
      const deliveryId = await queue(4);
      await deliver(db, deliveryId, deps);
      expect(await rowOf(deliveryId)).toMatchObject({
        status: "held",
        nextAttemptAt: new Date("2099-01-08T04:00:00Z"),
      });

      await saveAlertSettings(db, workspaceId, form({ timezone: "Europe/Moscow" }));

      dueNow(await rowOf(deliveryId));
      await sweep();
      await deliver(db, deliveryId, deps);

      expect(sent).toHaveLength(1);
      expect(await statusOf(deliveryId)).toBe("sent");
    });

    it("sends a held Severity 5 alert within a minute of the bypass being turned on, and holds the Severity 4 one", async () => {
      const workspaceId = await newWorkspace();
      const { queue } = await alerting(workspaceId);
      await saveAlertSettings(db, workspaceId, quiet());

      const { deps, sent } = recording(new Date("2099-01-07T20:00:00Z"));
      const four = await queue(4);
      const five = await queue(5);
      await deliver(db, four, deps);
      await deliver(db, five, deps);
      expect(sent).toHaveLength(0);
      expect((await Promise.all([statusOf(four), statusOf(five)])).map(String).sort()).toEqual(["held", "held"]);

      await saveAlertSettings(db, workspaceId, quiet({ severity5Bypasses: true }));

      dueNow(await rowOf(five));
      dueNow(await rowOf(four));
      await sweep();
      await deliver(db, five, deps);

      expect(sent).toHaveLength(1);
      expect(await statusOf(five)).toBe("sent");
      // Still inside quiet hours: it waits for 07:00 again, not for when the bypass came on.
      expect(await rowOf(four)).toMatchObject({ status: "held", nextAttemptAt: new Date("2099-01-08T04:00:00Z") });
    });

    it("sends an alert the rate limit holds within a minute of alerts_per_hour being raised", async () => {
      const workspaceId = await newWorkspace();
      const { queue } = await alerting(workspaceId);
      await saveAlertSettings(db, workspaceId, form({ alertsPerHour: "2", burstWindowSeconds: "0" }));

      const { deps, sent } = recording(new Date("2099-01-07T12:00:00Z"));
      const ids = [await queue(4), await queue(4), await queue(4)];
      for (const id of ids) await deliver(db, id, deps);
      expect(sent).toHaveLength(2);
      const heldId = present(ids[2]);
      expect(await rowOf(heldId)).toMatchObject({ status: "held", nextAttemptAt: new Date("2099-01-07T13:00:00Z") });

      // A third in the hour is one more than the limit was, so the alert can go.
      await saveAlertSettings(db, workspaceId, form({ alertsPerHour: "3", burstWindowSeconds: "0" }));

      dueNow(await rowOf(heldId));
      await sweep();
      await deliver(db, heldId, { ...deps, now: () => new Date("2099-01-07T12:01:00Z") });

      expect(sent).toHaveLength(3);
      expect(await statusOf(heldId)).toBe("sent");
    });

    it("adds no Log row to a held Item when the same settings are saved again", async () => {
      const workspaceId = await newWorkspace();
      const { queue } = await alerting(workspaceId);
      await saveAlertSettings(db, workspaceId, quiet());

      const { deps } = recording(new Date("2099-01-07T20:00:00Z"));
      const deliveryId = await queue(4);
      await deliver(db, deliveryId, deps);
      const held = await rowOf(deliveryId);
      expect(await logOf(deliveryId)).toEqual(["Held until 07:00: quiet hours"]);

      await saveAlertSettings(db, workspaceId, quiet());

      expect(await rowOf(deliveryId)).toEqual(held);
      expect(await logOf(deliveryId)).toEqual(["Held until 07:00: quiet hours"]);
    });

    it("leaves an alert the hosted email cap holds until the next local day, and its Log alone", async () => {
      const workspaceId = await newWorkspace();
      const { queue } = await alerting(workspaceId, "email");
      await saveAlertSettings(db, workspaceId, form({ alertsPerHour: "1000", burstWindowSeconds: "0" }));
      // The day's 50 mails have gone, so the next one is the cap's.
      await db.insert(sentMessage).values(
        Array.from({ length: 50 }, (_, index) => ({
          workspaceId,
          type: "email" as const,
          sentAt: new Date(new Date("2099-01-07T08:00:00Z").getTime() + index * 1_000),
        })),
      );
      const notices: string[] = [];
      const { deps, sent } = recording(new Date("2099-01-07T12:00:00Z"), {
        queueNotice: (_tx, id) => {
          notices.push(id);
          return Promise.resolve();
        },
      });

      const deliveryId = await queue(4);
      await deliver(db, deliveryId, deps);
      expect(sent).toHaveLength(0);
      expect(await rowOf(deliveryId)).toMatchObject({
        status: "held",
        holdReason: "email-cap",
        nextAttemptAt: new Date("2099-01-08T00:00:00Z"),
      });
      expect(notices).toEqual([workspaceId]);

      // The burst window is one the cap doesn't care about, and the hold stays where it was.
      await saveAlertSettings(db, workspaceId, form({ alertsPerHour: "1000", burstWindowSeconds: "30" }));

      expect(await rowOf(deliveryId)).toMatchObject({
        status: "held",
        holdReason: "email-cap",
        nextAttemptAt: new Date("2099-01-08T00:00:00Z"),
      });
      expect(await logOf(deliveryId)).toEqual(["Held until 00:00: the hosted limit of 50 mails a day"]);
      expect(notices).toEqual([workspaceId]);
    });
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
