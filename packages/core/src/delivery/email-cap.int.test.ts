import {
  action,
  actionDestination,
  closeDb,
  createDb,
  type Db,
  delivery,
  destination,
  eq,
  item,
  itemLog,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMailer, type MailMessage } from "../mail/mailer.ts";
import { deliver, type DeliverDeps, type Destination } from "./deliver.ts";
import { type EmailCap, sendEmailCapNotice } from "./email-cap.ts";
import { createEmailSender } from "./email.ts";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

// In the future, so a held Delivery isn't due by the database's clock until a test says so.
const at = (day: number, time: string) => new Date(`2099-01-${String(day).padStart(2, "0")}T${time}Z`);

describe("alert email", () => {
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

  /** A Workspace whose alerts neither burst nor hit the rate limit, so only the cap holds them. */
  async function seed(settings: Partial<typeof workspace.$inferInsert> = {}) {
    const ownerId = crypto.randomUUID();
    const ownerEmail = `${ownerId}@example.com`;
    await db.insert(user).values({ id: ownerId, name: "Owner", email: ownerEmail });
    const [ws] = await db
      .insert(workspace)
      .values({ name: "Workspace", ownerUserId: ownerId, alertsPerHour: 1000, burstWindowSeconds: 0, ...settings })
      .returning();
    const workspaceId = present(ws).id;
    const [src] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "rss",
        name: "Hacker News",
        config: { url: "https://feeds.test/hn.rss" },
        schedule: "*/15 * * * *",
      })
      .returning();
    const sourceId = present(src).id;

    const addDestination = async (values: { type: Destination["type"]; name: string; confirmedAt?: Date | null }) => {
      const [row] = await db
        .insert(destination)
        .values({
          workspaceId,
          confirmedAt: new Date(),
          config: { address: `${values.name}@example.com` },
          ...values,
        })
        .returning();
      return present(row).id;
    };
    const [saved] = await db
      .insert(action)
      .values({
        workspaceId,
        name: "critical",
        kind: "alert",
        definition: {
          action: "critical",
          when: { field: "severity", op: "gte", value: 4 },
          kind: "alert",
          // Only has to parse: which Destination an alert goes to is on its Delivery.
          destinations: [crypto.randomUUID()],
        },
      })
      .returning();
    const actionId = present(saved).id;

    let count = 0;
    /** A queued alert to this Destination, about a new Item. */
    const alert = async (destinationId: string) => {
      count += 1;
      const [captured] = await db
        .insert(item)
        .values({
          workspaceId,
          sourceId,
          externalId: String(count),
          url: `https://news.test/${String(count)}`,
          title: `Advisory ${String(count)}`,
          body: "An entry.",
          raw: {},
          summary: "Patch now.",
          severity: 5,
          importance: 3,
        })
        .returning();
      const itemId = present(captured).id;
      await db.insert(actionDestination).values({ actionId, destinationId }).onConflictDoNothing();
      const [row] = await db.insert(delivery).values({ actionId, itemId, destinationId }).returning();
      return { itemId, deliveryId: present(row).id };
    };
    return { workspaceId, ownerEmail, addDestination, alert };
  }

  /** Deps that send mail to a list, on hosted unless the test turns the cap off. */
  function recording({ capped = true, mailer }: { capped?: boolean; mailer?: (mail: MailMessage) => void } = {}) {
    const mails: MailMessage[] = [];
    const notices: string[] = [];
    const sender = createEmailSender(
      {
        send: (mail) => {
          mailer?.(mail);
          mails.push(mail);
          return Promise.resolve();
        },
      },
      undefined,
    );
    const emailCap: EmailCap = {
      queueNotice: (_tx, workspaceId) => {
        notices.push(workspaceId);
        return Promise.resolve();
      },
    };
    const noRetry = () => Promise.reject(new Error("No test here expects a retry"));
    const deps: DeliverDeps = {
      senders: { email: sender, telegram: sender, webhook: sender },
      appUrl: "https://watchdog.test",
      retryDelivery: noRetry,
      ...(capped && { emailCap }),
    };
    return { mails, notices, deps };
  }

  const rowOf = async (deliveryId: string) => db.query.delivery.findFirst({ where: eq(delivery.id, deliveryId) });
  const logOf = async (itemId: string) =>
    (await db.select().from(itemLog).where(eq(itemLog.itemId, itemId)).orderBy(itemLog.id)).map((row) => row.message);
  /** What the sweep does when a held Delivery's time comes. */
  const release = (deliveryId: string) =>
    db.update(delivery).set({ status: "queued", nextAttemptAt: null }).where(eq(delivery.id, deliveryId));

  /** Sends this many alerts to a Destination, one mail each, a minute apart from this time. */
  async function send(
    seeded: Awaited<ReturnType<typeof seed>>,
    destinationId: string,
    deps: DeliverDeps,
    count: number,
    start: Date,
  ) {
    for (let index = 0; index < count; index++) {
      const { deliveryId } = await seeded.alert(destinationId);
      const now = new Date(start.getTime() + index * 60_000);
      await deliver(db, deliveryId, { ...deps, now: () => now });
    }
  }

  describe("the hosted daily cap", () => {
    it("sends the 49th and 50th mail of a local day, and holds the 51st until the next", async () => {
      const seeded = await seed();
      const address = await seeded.addDestination({ type: "email", name: "me" });
      const { mails, notices, deps } = recording();
      await send(seeded, address, deps, 48, at(7, "08:00:00"));
      expect(mails).toHaveLength(48);

      const clock = () => at(7, "12:00:00");
      const fortyNinth = await seeded.alert(address);
      await deliver(db, fortyNinth.deliveryId, { ...deps, now: clock });
      expect(await rowOf(fortyNinth.deliveryId)).toMatchObject({ status: "sent" });
      const fiftieth = await seeded.alert(address);
      await deliver(db, fiftieth.deliveryId, { ...deps, now: clock });
      expect(await rowOf(fiftieth.deliveryId)).toMatchObject({ status: "sent" });
      expect(mails).toHaveLength(50);
      expect(notices).toEqual([]);

      const fiftyFirst = await seeded.alert(address);
      await deliver(db, fiftyFirst.deliveryId, { ...deps, now: clock });

      expect(mails).toHaveLength(50);
      expect(await rowOf(fiftyFirst.deliveryId)).toMatchObject({
        status: "held",
        attempts: 0,
        nextAttemptAt: at(8, "00:00:00"),
      });
      expect(await logOf(fiftyFirst.itemId)).toEqual(["Held until 00:00: the hosted limit of 50 mails a day"]);
    });

    it("queues one notice that day, however many mails it holds", async () => {
      const seeded = await seed();
      const address = await seeded.addDestination({ type: "email", name: "me" });
      const { notices, deps } = recording();
      await send(seeded, address, deps, 53, at(7, "08:00:00"));

      expect(notices).toEqual([seeded.workspaceId]);
    });

    it("tells the Workspace's owner what the notice says, from the alert sender", async () => {
      const seeded = await seed({ timezone: "Asia/Tokyo" });
      const notices: MailMessage[] = [];
      const mailer = {
        send: (mail: MailMessage) => {
          notices.push(mail);
          return Promise.resolve();
        },
      };

      await sendEmailCapNotice(db, seeded.workspaceId, mailer, "alerts@example.com");

      expect(notices).toHaveLength(1);
      const notice = present(notices[0]);
      expect(notice.to).toBe(seeded.ownerEmail);
      expect(notice.from).toBe("alerts@example.com");
      expect(notice.subject).toBe("[Watchdog] Alert mail is held until tomorrow");
      expect(notice.text).toContain("50");
      expect(notice.text).toContain("Asia/Tokyo");
      expect(notice.text).toContain("Nothing is lost");
    });

    it("sends no notice for a Workspace that has gone", async () => {
      const notices: MailMessage[] = [];

      await sendEmailCapNotice(
        db,
        crypto.randomUUID(),
        {
          send: (mail) => {
            notices.push(mail);
            return Promise.resolve();
          },
        },
        undefined,
      );

      expect(notices).toEqual([]);
    });

    it("records the hold and the notice together, so a failure repeats neither", async () => {
      const seeded = await seed();
      const address = await seeded.addDestination({ type: "email", name: "me" });
      const { notices, deps } = recording();
      await send(seeded, address, deps, 50, at(7, "08:00:00"));
      const { deliveryId } = await seeded.alert(address);

      await expect(
        deliver(db, deliveryId, {
          ...deps,
          now: () => at(7, "12:00:00"),
          emailCap: { queueNotice: () => Promise.reject(new Error("Queue down")) },
        }),
      ).rejects.toThrow("Queue down");
      expect(await rowOf(deliveryId)).toMatchObject({ status: "queued" });

      // The job's own retry.
      await deliver(db, deliveryId, { ...deps, now: () => at(7, "12:00:30") });
      expect(await rowOf(deliveryId)).toMatchObject({ status: "held" });
      expect(notices).toEqual([seeded.workspaceId]);
    });

    it("still counts the day when its local midnight doesn't exist", async () => {
      // On 8 March 2026 clocks in Havana go from 00:00 to 01:00, at 05:00 UTC.
      const seeded = await seed({ timezone: "America/Havana" });
      const address = await seeded.addDestination({ type: "email", name: "me" });
      const { mails, deps } = recording();
      await send(seeded, address, deps, 50, new Date("2026-03-08T05:10:00Z"));
      expect(mails).toHaveLength(50);

      const held = await seeded.alert(address);
      await deliver(db, held.deliveryId, { ...deps, now: () => new Date("2026-03-08T12:00:00Z") });

      // The next midnight there is at 04:00 UTC, now that the clocks are ahead.
      expect(await rowOf(held.deliveryId)).toMatchObject({
        status: "held",
        nextAttemptAt: new Date("2026-03-09T04:00:00Z"),
      });
    });

    it("lets only one of two addresses take the 50th place", async () => {
      const seeded = await seed();
      const first = await seeded.addDestination({ type: "email", name: "first" });
      const second = await seeded.addDestination({ type: "email", name: "second" });
      const { mails, deps } = recording();
      await send(seeded, first, deps, 49, at(7, "08:00:00"));
      const racing = [await seeded.alert(first), await seeded.alert(second)];

      await Promise.all(
        racing.map(({ deliveryId }) => deliver(db, deliveryId, { ...deps, now: () => at(7, "12:00:00") })),
      );

      expect(mails).toHaveLength(50);
      const statuses = await Promise.all(racing.map(async ({ deliveryId }) => (await rowOf(deliveryId))?.status));
      expect(statuses.sort()).toEqual(["held", "sent"]);
    });

    it("lets the Workspace be saved while a mail is going out", async () => {
      const seeded = await seed();
      const address = await seeded.addDestination({ type: "email", name: "me" });
      const { deps } = recording({
        mailer: () => undefined,
      });
      const { deliveryId } = await seeded.alert(address);
      const email = deps.senders.email;

      await deliver(db, deliveryId, {
        ...deps,
        senders: {
          ...deps.senders,
          email: {
            send: async (target, message) => {
              // Would wait for the send's own lock, and so never end, if the send held the Workspace's row.
              await Promise.race([
                db.update(workspace).set({ name: "Renamed" }).where(eq(workspace.id, seeded.workspaceId)),
                new Promise((_, reject) => setTimeout(() => { reject(new Error("The save waited")); }, 3000)),
              ]);
              await email.send(target, message);
            },
          },
        },
      });

      expect(await rowOf(deliveryId)).toMatchObject({ status: "sent" });
    });

    it("sends the held mails as one Grouped alert the next local day, and a new notice only if it fills up again", async () => {
      const seeded = await seed();
      const address = await seeded.addDestination({ type: "email", name: "me" });
      const { mails, notices, deps } = recording();
      await send(seeded, address, deps, 50, at(7, "08:00:00"));
      const held = [await seeded.alert(address), await seeded.alert(address), await seeded.alert(address)];
      for (const { deliveryId } of held) await deliver(db, deliveryId, { ...deps, now: () => at(7, "12:00:00") });
      expect(notices).toHaveLength(1);

      for (const { deliveryId } of held) await release(deliveryId);
      for (const { deliveryId } of held) await deliver(db, deliveryId, { ...deps, now: () => at(8, "00:00:30") });

      expect(mails).toHaveLength(51);
      expect(present(mails[50]).subject).toBe("[Watchdog] 3 alerts");
      for (const { deliveryId } of held) expect(await rowOf(deliveryId)).toMatchObject({ status: "sent" });
      expect(await logOf(present(held[0]).itemId)).toEqual([
        "Held until 00:00: the hosted limit of 50 mails a day",
        "Sent to me in a group of 3",
      ]);

      // The Grouped alert was the first of the day's 50, so 49 more go, and the next is held.
      await send(seeded, address, deps, 49, at(8, "08:00:00"));
      expect(mails).toHaveLength(100);
      expect(notices).toHaveLength(1);

      const next = await seeded.alert(address);
      await deliver(db, next.deliveryId, { ...deps, now: () => at(8, "12:00:00") });
      expect(await rowOf(next.deliveryId)).toMatchObject({ status: "held", nextAttemptAt: at(9, "00:00:00") });
      expect(notices).toHaveLength(2);
    });

    it("counts a local day in the Workspace timezone", async () => {
      // Midnight in Tokyo in January is 15:00 UTC.
      const seeded = await seed({ timezone: "Asia/Tokyo" });
      const address = await seeded.addDestination({ type: "email", name: "me" });
      const { mails, deps } = recording();
      await send(seeded, address, deps, 50, at(7, "14:00:00"));

      const sameDay = await seeded.alert(address);
      await deliver(db, sameDay.deliveryId, { ...deps, now: () => at(7, "14:59:00") });
      expect(await rowOf(sameDay.deliveryId)).toMatchObject({ status: "held", nextAttemptAt: at(7, "15:00:00") });

      const nextDay = await seeded.alert(address);
      // The very first moment of the day is part of it.
      await deliver(db, nextDay.deliveryId, { ...deps, now: () => at(7, "15:00:00") });
      expect(mails).toHaveLength(51);
      expect(await rowOf(nextDay.deliveryId)).toMatchObject({ status: "sent" });
    });

    it("counts a Workspace's mail across its addresses, and no other Workspace's", async () => {
      const seeded = await seed();
      const first = await seeded.addDestination({ type: "email", name: "first" });
      const second = await seeded.addDestination({ type: "email", name: "second" });
      const { deps } = recording();
      await send(seeded, first, deps, 25, at(7, "08:00:00"));
      await send(seeded, second, deps, 25, at(7, "09:00:00"));

      const other = await seed();
      const otherAddress = await other.addDestination({ type: "email", name: "other" });
      const otherAlert = await other.alert(otherAddress);
      await deliver(db, otherAlert.deliveryId, { ...deps, now: () => at(7, "12:00:00") });
      expect(await rowOf(otherAlert.deliveryId)).toMatchObject({ status: "sent" });

      const held = await seeded.alert(second);
      await deliver(db, held.deliveryId, { ...deps, now: () => at(7, "12:00:00") });
      expect(await rowOf(held.deliveryId)).toMatchObject({ status: "held" });
    });

    it("leaves Telegram alone at the cap, and doesn't count it", async () => {
      const seeded = await seed();
      const address = await seeded.addDestination({ type: "email", name: "me" });
      const chat = await seeded.addDestination({ type: "telegram", name: "chat" });
      const { deps } = recording();
      await send(seeded, chat, deps, 60, at(7, "08:00:00"));
      await send(seeded, address, deps, 50, at(7, "10:00:00"));

      const telegram = await seeded.alert(chat);
      await deliver(db, telegram.deliveryId, { ...deps, now: () => at(7, "12:00:00") });
      expect(await rowOf(telegram.deliveryId)).toMatchObject({ status: "sent" });

      const mail = await seeded.alert(address);
      await deliver(db, mail.deliveryId, { ...deps, now: () => at(7, "12:00:00") });
      expect(await rowOf(mail.deliveryId)).toMatchObject({ status: "held" });
    });

  });

  it("sends all 60 of a day's mails on self-hosted, which has no cap", async () => {
    const seeded = await seed();
    const address = await seeded.addDestination({ type: "email", name: "me" });
    const { mails, notices, deps } = recording({ capped: false });

    await send(seeded, address, deps, 60, at(7, "08:00:00"));

    expect(mails).toHaveLength(60);
    expect(notices).toEqual([]);
  });

  it("fails a Delivery to an unconfirmed address at once, sends nothing, and the Log says why", async () => {
    const seeded = await seed();
    const address = await seeded.addDestination({ type: "email", name: "me", confirmedAt: null });
    const { mails, deps } = recording();
    const { deliveryId, itemId } = await seeded.alert(address);

    await deliver(db, deliveryId, deps);

    expect(mails).toEqual([]);
    expect(await rowOf(deliveryId)).toMatchObject({ status: "failed", attempts: 1, nextAttemptAt: null });
    expect(await logOf(itemId)).toEqual([
      "Sending to me failed: the address isn't confirmed yet. It won't be retried",
    ]);
  });

  describe("through real SMTP", () => {
    let mailpit: StartedTestContainer;

    beforeAll(async () => {
      mailpit = await new GenericContainer("axllent/mailpit:v1.33.0")
        .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: "1", MP_SMTP_AUTH_ALLOW_INSECURE: "1" })
        .withExposedPorts(1025, 8025)
        .withWaitStrategy(Wait.forHttp("/livez", 8025))
        .start();
      return async () => {
        await mailpit.stop();
      };
    }, 120_000);

    it("delivers a queued alert with the Item's title, its link and the Condition in words", async () => {
      const seeded = await seed();
      const address = await seeded.addDestination({ type: "email", name: "me" });
      const { deliveryId, itemId } = await seeded.alert(address);
      const mailer = createMailer({
        mode: "self-hosted",
        smtp: {
          host: mailpit.getHost(),
          port: mailpit.getMappedPort(1025),
          user: "watchdog",
          password: "watchdog",
          from: "Watchdog <watchdog@example.com>",
        },
      });
      const sender = createEmailSender(mailer, "Watchdog alerts <alerts@example.com>");
      const { deps } = recording({ capped: false });

      await deliver(db, deliveryId, { ...deps, senders: { ...deps.senders, email: sender } });

      expect(await rowOf(deliveryId)).toMatchObject({ status: "sent" });
      const api = `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}/api/v1`;
      const list = z
        .object({ messages: z.array(z.object({ ID: z.string() })) })
        .parse(await (await fetch(`${api}/messages`)).json());
      const mail = z
        .object({
          Subject: z.string(),
          Text: z.string(),
          HTML: z.string(),
          From: z.object({ Address: z.string() }),
          To: z.array(z.object({ Address: z.string() })),
        })
        .parse(await (await fetch(`${api}/message/${present(list.messages[0]).ID}`)).json());
      expect(mail.Subject).toBe("[Watchdog] Act today · Advisory 1");
      expect(mail.From.Address).toBe("alerts@example.com");
      expect(mail.To.map((to) => to.Address)).toEqual(["me@example.com"]);
      expect(mail.HTML).toBe("");
      expect(mail.Text).toContain("Advisory 1");
      expect(mail.Text).toContain(`https://watchdog.test/items/${itemId}`);
      expect(mail.Text).toContain("Why it fired: Severity is at least 4");
    }, 60_000);
  });
});
