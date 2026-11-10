import {
  closeDb,
  createDb,
  type Db,
  destination,
  eq,
  healthAlertDestination,
  migrate,
  sentMessage,
  source,
  sourceAlert,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { pollSource, type PollSourceDeps } from "../pipeline/capture.ts";
import { type Destination, FinalSendError, type Sender } from "./deliver.ts";
import { createEmailSender } from "./email.ts";
import { releaseDueSourceAlerts, sendSourceAlert, setPushSourceHealth, type SourceAlertDeps } from "./source-alert.ts";
import type { SourceAlertMessage } from "./source-alert-content.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const start = new Date("2026-11-03T15:00:00Z");
const minutesLater = (minutes: number) => new Date(start.getTime() + minutes * 60_000);
const appUrl = "https://watchdog.test";

describe("Source Health alerts", () => {
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

  /** A Workspace with one RSS Source, whose feed answers only while `feedUp` is true. */
  async function seed(settings: Partial<typeof workspace.$inferInsert> = {}) {
    const ownerId = crypto.randomUUID();
    const email = `${ownerId}@example.com`;
    await db.insert(user).values({ id: ownerId, name: "Owner", email });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: ownerId, ...settings }).returning();
    const workspaceId = present(ws).id;
    const [src] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "rss",
        name: "Release feed",
        config: { url: `https://feeds.test/${ownerId}.rss` },
        schedule: "*/15 * * * *",
      })
      .returning();
    const state = { feedUp: false };
    const pollDeps: PollSourceDeps = {
      fetch: () =>
        state.feedUp
          ? Promise.resolve(new Response(`<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title></channel></rss>`))
          : Promise.reject(new Error("connect ECONNREFUSED")),
      enqueueItems: () => Promise.resolve(),
      secrets: { encryptionKey: Buffer.alloc(32), authSecret: "unused-by-rss-sources" },
    };
    const sourceId = present(src).id;
    const poll = (at: Date) => pollSource(db, sourceId, { ...pollDeps, now: () => at });
    /** Ten failed polls a minute apart from `from`, which make the Source failing. */
    const fail = async (from = 0) => {
      for (let i = 0; i < 10; i += 1) await poll(minutesLater(from + i));
    };
    const name = async (values: Partial<typeof destination.$inferInsert> & { name: string }) => {
      const [row] = await db
        .insert(destination)
        .values({ workspaceId, type: "telegram", confirmedAt: new Date(), ...values })
        .returning();
      const destinationId = present(row).id;
      await db.insert(healthAlertDestination).values({ workspaceId, destinationId });
      return destinationId;
    };
    return { workspaceId, sourceId, email, state, poll, fail, name };
  }

  /** The deps, recording what each sender got and which retries were queued. */
  function recording(send: Sender<SourceAlertMessage>["send"] = () => Promise.resolve(), now?: () => Date) {
    const sent: { type: string; destination: Destination; message: SourceAlertMessage }[] = [];
    const retries: { alertId: string; at: Date }[] = [];
    const sender = (type: string): Sender<SourceAlertMessage> => ({
      send: async (target, message) => {
        sent.push({ type, destination: target, message });
        await send(target, message);
      },
    });
    const deps: SourceAlertDeps = {
      senders: { telegram: sender("telegram"), email: sender("email") },
      appUrl,
      retrySourceAlert: (_tx, alertId, at) => {
        retries.push({ alertId, at });
        return Promise.resolve();
      },
      ...(now && { now }),
    };
    return { sent, retries, deps };
  }

  const alertsOf = (sourceId: string) =>
    db.select().from(sourceAlert).where(eq(sourceAlert.sourceId, sourceId)).orderBy(sourceAlert.createdAt);

  /** What the worker does: the sweep releases the alerts that are due, and a job sends each. */
  async function deliverDue(sourceId: string, deps: SourceAlertDeps) {
    const released = await db.transaction((tx) => releaseDueSourceAlerts(tx));
    const mine = new Set((await alertsOf(sourceId)).map(({ id }) => id));
    for (const { id } of released) if (mine.has(id)) await sendSourceAlert(db, id, deps);
  }

  it("delivers exactly one failing alert and one recovered alert across a long failure", async () => {
    const seeded = await seed();
    const chat = await seeded.name({ name: "ops-chat" });
    const { deps, sent } = recording();

    // Three failed polls make it degraded, which alerts nobody.
    for (let i = 0; i < 3; i += 1) await seeded.poll(minutesLater(i));
    await deliverDue(seeded.sourceId, deps);
    expect(sent).toEqual([]);

    // Forty more: failing from the tenth, and then every hour for a day and more.
    for (let i = 3; i < 13; i += 1) await seeded.poll(minutesLater(i));
    for (let i = 1; i <= 30; i += 1) await seeded.poll(minutesLater(13 + i * 60));
    await deliverDue(seeded.sourceId, deps);
    await deliverDue(seeded.sourceId, deps);
    expect(sent.map(({ message }) => message)).toEqual([
      { health: "failing", source: "Release feed", error: "connect ECONNREFUSED", link: `${appUrl}/sources` },
    ]);

    seeded.state.feedUp = true;
    await seeded.poll(minutesLater(40 * 60));
    await seeded.poll(minutesLater(41 * 60));
    await deliverDue(seeded.sourceId, deps);
    await deliverDue(seeded.sourceId, deps);

    expect(sent.map(({ type, destination: to, message }) => [type, to.id, message.health])).toEqual([
      ["telegram", chat, "failing"],
      ["telegram", chat, "recovered"],
    ]);
    expect(await alertsOf(seeded.sourceId)).toMatchObject([
      { kind: "failing", status: "sent", attempts: 1 },
      { kind: "recovered", status: "sent", attempts: 1 },
    ]);
    // Each counts against the Destination's rate limit, as an alert does.
    expect(await db.select().from(sentMessage).where(eq(sentMessage.destinationId, chat))).toHaveLength(2);
  });

  it("goes to the account's email when no Destination is named", async () => {
    const seeded = await seed();
    await seeded.fail();
    const mails: { to: string; subject: string; text: string }[] = [];
    const email = createEmailSender({ send: (mail) => Promise.resolve(void mails.push(mail)) }, undefined);
    const { deps } = recording();

    await deliverDue(seeded.sourceId, { ...deps, senders: { ...deps.senders, email } });

    expect(mails).toEqual([
      {
        to: seeded.email,
        subject: "[Watchdog] Source failing · Release feed",
        text: `Source Release feed is failing\nconnect ECONNREFUSED\n${appUrl}/sources`,
      },
    ]);
    expect(await alertsOf(seeded.sourceId)).toMatchObject([{ destinationId: null, status: "sent" }]);
    // The sign-in address isn't a Destination: its mail counts toward the Workspace's cap and no rate limit.
    const counted = await db.select().from(sentMessage).where(eq(sentMessage.workspaceId, seeded.workspaceId));
    expect(counted).toMatchObject([{ destinationId: null, type: "email" }]);
  });

  it("goes to every confirmed Destination the setting names, and not to the sign-in address", async () => {
    const seeded = await seed();
    const chat = await seeded.name({ name: "ops-chat" });
    const inbox = await seeded.name({ name: "Team inbox", type: "email", config: { address: "team@example.com" } });
    await seeded.name({ name: "Unconfirmed", type: "email", config: { address: "new@example.com" }, confirmedAt: null });
    await seeded.fail();
    const { deps, sent } = recording();

    await deliverDue(seeded.sourceId, deps);

    expect(sent.map(({ type, destination: to }) => [type, to.id]).sort()).toEqual(
      [
        ["telegram", chat],
        ["email", inbox],
      ].sort(),
    );
  });

  it("holds an alert during quiet hours and sends it when they end", async () => {
    // 15:00 UTC is inside 14:00 to 16:00.
    const seeded = await seed({ quietHoursStart: "14:00", quietHoursEnd: "16:00", severity5BypassesQuietHours: true });
    await seeded.name({ name: "ops-chat" });
    await seeded.fail();
    let now = minutesLater(10);
    const { deps, sent } = recording(undefined, () => now);

    await deliverDue(seeded.sourceId, deps);
    expect(sent).toEqual([]);
    expect(await alertsOf(seeded.sourceId)).toMatchObject([
      { status: "held", nextAttemptAt: minutesLater(60), retryFrom: minutesLater(60), attempts: 0 },
    ]);

    // The sweep finds it once its time has come.
    await db.update(sourceAlert).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(sourceAlert.sourceId, seeded.sourceId));
    now = minutesLater(61);
    await deliverDue(seeded.sourceId, deps);
    expect(sent).toHaveLength(1);
    expect(await alertsOf(seeded.sourceId)).toMatchObject([{ status: "sent" }]);
  });

  it("holds an alert the Destination's rate limit has no room for, and sends it inside a burst window", async () => {
    const seeded = await seed({ alertsPerHour: 1, burstWindowSeconds: 60 });
    const chat = await seeded.name({ name: "ops-chat" });
    await seeded.fail();
    const now = minutesLater(30);
    const sentAt = minutesLater(10);
    await db.insert(sentMessage).values({ workspaceId: seeded.workspaceId, destinationId: chat, type: "telegram", sentAt });
    const { deps, sent } = recording(undefined, () => now);

    await deliverDue(seeded.sourceId, deps);

    expect(sent).toEqual([]);
    expect(await alertsOf(seeded.sourceId)).toMatchObject([{ status: "held", nextAttemptAt: minutesLater(70) }]);

    // Inside the burst window a Delivery would wait to join a Grouped alert. A Health alert never joins
    // one, so it has nothing to wait for.
    await db.update(workspace).set({ alertsPerHour: 20 }).where(eq(workspace.id, seeded.workspaceId));
    await db.update(sentMessage).set({ sentAt: new Date(now.getTime() - 20_000) }).where(eq(sentMessage.destinationId, chat));
    await db.update(sourceAlert).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(sourceAlert.sourceId, seeded.sourceId));
    await deliverDue(seeded.sourceId, deps);
    expect(sent).toHaveLength(1);
  });

  it("sends a recovery after the failure it ends, when both were waiting", async () => {
    const seeded = await seed();
    const chat = await seeded.name({ name: "ops-chat" });
    await seeded.fail();
    seeded.state.feedUp = true;
    await seeded.poll(minutesLater(20));
    const [failing, recovered] = await alertsOf(seeded.sourceId);
    const { deps, sent } = recording();
    await db.transaction((tx) => releaseDueSourceAlerts(tx));

    // The recovery's job runs first: it waits a minute for the failing alert ahead of it.
    await sendSourceAlert(db, present(recovered).id, deps);
    expect(sent).toEqual([]);
    expect((await alertsOf(seeded.sourceId))[1]).toMatchObject({ kind: "recovered", status: "held" });

    await sendSourceAlert(db, present(failing).id, deps);
    await db.update(sourceAlert).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(sourceAlert.id, present(recovered).id));
    await deliverDue(seeded.sourceId, deps);
    expect(sent.map(({ destination: to, message }) => [to.id, message.health])).toEqual([
      [chat, "failing"],
      [chat, "recovered"],
    ]);
  });

  it("goes to the sign-in address when none of the named Destinations is confirmed", async () => {
    const seeded = await seed();
    await seeded.name({ name: "Unconfirmed", type: "email", config: { address: "new@example.com" }, confirmedAt: null });
    await seeded.fail();
    expect(await alertsOf(seeded.sourceId)).toMatchObject([{ kind: "failing", destinationId: null }]);
  });

  it("holds a mail the hosted email cap has no room for, and queues the day's notice", async () => {
    const seeded = await seed();
    await seeded.fail();
    const now = minutesLater(30);
    await db
      .insert(sentMessage)
      .values(Array.from({ length: 50 }, () => ({ workspaceId: seeded.workspaceId, type: "email" as const, sentAt: start })));
    const notices: string[] = [];
    const { deps, sent } = recording(undefined, () => now);

    await deliverDue(seeded.sourceId, {
      ...deps,
      emailCap: { queueNotice: (_tx, workspaceId) => Promise.resolve(void notices.push(workspaceId)) },
    });

    expect(sent).toEqual([]);
    expect(notices).toEqual([seeded.workspaceId]);
    // Midnight in the Workspace timezone, UTC by default.
    expect(await alertsOf(seeded.sourceId)).toMatchObject([
      { status: "held", nextAttemptAt: new Date("2026-11-04T00:00:00Z") },
    ]);
  });

  it("retries a failed send with the Delivery backoff, then records the send", async () => {
    const seeded = await seed();
    const chat = await seeded.name({ name: "ops-chat" });
    await seeded.fail();
    let up = false;
    const { deps, sent, retries } = recording(() => (up ? Promise.resolve() : Promise.reject(new Error("Telegram can't be reached"))));

    await deliverDue(seeded.sourceId, deps);

    const [failed] = await alertsOf(seeded.sourceId);
    expect(failed).toMatchObject({ status: "queued", attempts: 1, lastError: "Telegram can't be reached" });
    const retryAt = present(failed?.nextAttemptAt ?? undefined);
    expect(retries).toEqual([{ alertId: failed?.id, at: retryAt }]);
    expect(retryAt.getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(retryAt.getTime() - Date.now()).toBeLessThanOrEqual(30_000);

    // A job that runs before the retry is due ends without sending.
    await sendSourceAlert(db, present(failed).id, deps);
    expect(sent).toHaveLength(1);

    up = true;
    await db.update(sourceAlert).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(sourceAlert.id, present(failed).id));
    await sendSourceAlert(db, present(failed).id, deps);
    expect(await alertsOf(seeded.sourceId)).toMatchObject([{ status: "sent", attempts: 2, lastError: null }]);
    expect(await db.select().from(sentMessage).where(eq(sentMessage.destinationId, chat))).toHaveLength(1);
  });

  it("fails at once on a final refusal, and shows it on the Destination", async () => {
    const seeded = await seed();
    const chat = await seeded.name({ name: "ops-chat" });
    await seeded.fail();
    const { deps, retries } = recording(() => Promise.reject(new FinalSendError("the bot was removed from the chat")));

    await deliverDue(seeded.sourceId, deps);

    expect(retries).toEqual([]);
    expect(await alertsOf(seeded.sourceId)).toMatchObject([
      { status: "failed", attempts: 1, nextAttemptAt: null, lastError: "the bot was removed from the chat" },
    ]);
    const [target] = await db.select().from(destination).where(eq(destination.id, chat));
    expect(target?.lastError).toBe("the bot was removed from the chat");
  });

  it("drops an alert still waiting when its Destination is removed", async () => {
    const seeded = await seed();
    const chat = await seeded.name({ name: "ops-chat" });
    await seeded.fail();
    await db.delete(destination).where(eq(destination.id, chat));
    expect(await alertsOf(seeded.sourceId)).toEqual([]);
  });

  it("alerts once when a push Source loses access, and once when access returns", async () => {
    const seeded = await seed();
    const [bound] = await db
      .insert(source)
      .values({
        workspaceId: seeded.workspaceId,
        type: "telegram",
        name: "Release chat",
        config: { via: "bot", chatId: -100123 },
        schedule: null,
        nextPollAt: null,
      })
      .returning();
    const sourceId = present(bound).id;
    const set = (lost: string | null) => db.transaction((tx) => setPushSourceHealth(tx, eq(source.id, sourceId), lost, start));

    await set("The bot was removed from this chat, or left it.");
    await set("The bot was removed from this chat and banned from it.");
    expect(await db.query.source.findFirst({ where: eq(source.id, sourceId) })).toMatchObject({
      health: "failing",
      lastError: "The bot was removed from this chat and banned from it.",
      lastErrorAt: start,
    });
    await set(null);
    await set(null);

    expect(await db.query.source.findFirst({ where: eq(source.id, sourceId) })).toMatchObject({
      health: "ok",
      lastError: null,
      lastSuccessAt: start,
    });
    expect(await alertsOf(sourceId)).toMatchObject([
      { kind: "failing", error: "The bot was removed from this chat, or left it." },
      { kind: "recovered", error: null },
    ]);
  });
});
