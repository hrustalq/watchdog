import { closeDb, createDb, type Db, destination, eq, migrate, sentMessage, user, workspace } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createMailer } from "../mail/mailer.ts";
import { encryptSecret } from "../secrets/secrets.ts";
import type { DeliverDeps, Destination } from "./deliver.ts";
import { createEmailSender } from "./email.ts";
import { sendTestAlert } from "./test-alert.ts";
import { createWebhookSender } from "./webhook.ts";

const mailpitImage = "axllent/mailpit:v1.33.0";
const encryptionKey = Buffer.alloc(32, 7);
const appUrl = "https://watchdog.test";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

const notUsed = { send: () => Promise.reject(new Error("not used in this test")) };

describe("sendTestAlert", () => {
  let postgres: TestPostgres;
  let db: Db;
  let mailpit: StartedTestContainer;

  beforeAll(async () => {
    [postgres, mailpit] = await Promise.all([
      startPostgres(),
      new GenericContainer(mailpitImage)
        .withEnvironment({ MP_SMTP_AUTH_ACCEPT_ANY: "1", MP_SMTP_AUTH_ALLOW_INSECURE: "1" })
        .withExposedPorts(1025, 8025)
        .withWaitStrategy(Wait.forHttp("/livez", 8025))
        .start(),
    ]);
    await migrate(postgres.url);
    db = createDb(postgres.url);
    return async () => {
      await closeDb(db);
      await Promise.all([postgres.stop(), mailpit.stop()]);
    };
  }, 120_000);

  async function seedWorkspace() {
    const ownerId = crypto.randomUUID();
    await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: ownerId }).returning();
    return present(ws).id;
  }

  async function addDestination(values: Omit<typeof destination.$inferInsert, "workspaceId">) {
    const [row] = await db
      .insert(destination)
      .values({ workspaceId: await seedWorkspace(), ...values })
      .returning();
    return present(row);
  }

  const stored = async (id: string) =>
    present((await db.select().from(destination).where(eq(destination.id, id)))[0]);

  const mailpitApi = () => `http://${mailpit.getHost()}:${String(mailpit.getMappedPort(8025))}/api/v1`;

  function senders(overrides: Partial<DeliverDeps["senders"]>): DeliverDeps["senders"] {
    return { telegram: notUsed, email: notUsed, webhook: notUsed, ...overrides };
  }

  it("mails a confirmed address the example alert through SMTP", async () => {
    const address = `${crypto.randomUUID()}@example.com`;
    const target = await addDestination({ type: "email", name: "Team inbox", config: { address }, confirmedAt: new Date() });
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

    const result = await sendTestAlert(db, target, {
      senders: senders({ email: createEmailSender(mailer, undefined) }),
      appUrl,
      emailCapped: false,
    });

    expect(result).toEqual({ status: "sent" });
    const list = z
      .object({ messages: z.array(z.object({ ID: z.string(), Subject: z.string(), To: z.array(z.object({ Address: z.string() })) })) })
      .parse(await (await fetch(`${mailpitApi()}/search?query=${encodeURIComponent(`to:${address}`)}`)).json());
    const mail = present(list.messages[0]);
    expect(mail.Subject).toMatch(/^\[Watchdog\] .+ · Test alert from Watchdog$/);
    const body = z
      .object({ Text: z.string() })
      .parse(await (await fetch(`${mailpitApi()}/message/${mail.ID}`)).json()).Text;
    expect(body).toContain("Test alert from Watchdog");
    expect(body).toContain("Rating: Severity 3, Importance 3");
    expect(body).toContain(`${appUrl}/`);
    expect(body).toContain("Why it fired: Send a test was pressed on the Destinations screen");
    const counted = await db.select().from(sentMessage).where(eq(sentMessage.destinationId, target.id));
    expect(counted).toHaveLength(1);
  }, 60_000);

  it("records a webhook's 500 as the Destination's error, and clears it when a later test works", async () => {
    const target = await addDestination({
      type: "webhook",
      name: "ops-hook",
      config: { url: "https://hooks.test/watchdog" },
      secretCiphertext: encryptSecret("a-webhook-secret", encryptionKey),
    });
    let status = 500;
    const bodies: unknown[] = [];
    const webhook = createWebhookSender({
      fetch: (_url, init) => {
        bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "null"));
        return Promise.resolve(new Response(null, { status }));
      },
      encryptionKey,
      mode: "hosted",
    });
    const deps = { senders: senders({ webhook }), appUrl, emailCapped: false };

    expect(await sendTestAlert(db, target, deps)).toEqual({ status: "failed", reason: "the receiver answered 500" });
    const failed = await stored(target.id);
    expect(failed.lastError).toBe("the receiver answered 500");
    expect(failed.lastErrorAt).toBeInstanceOf(Date);

    status = 204;
    expect(await sendTestAlert(db, await stored(target.id), deps)).toEqual({ status: "sent" });
    expect(await stored(target.id)).toMatchObject({ lastError: null, lastErrorAt: null });
    expect(bodies[0]).toMatchObject({
      version: 1,
      item: { title: "Test alert from Watchdog" },
      rating: { severity: 3, importance: 3 },
      firedBecause: "Send a test was pressed on the Destinations screen",
    });
  });

  it("sends no mail once a hosted Workspace has used the day's 50, and leaves the Destination's error alone", async () => {
    const target: Destination = await addDestination({
      type: "email",
      name: "Capped inbox",
      config: { address: "capped@example.com" },
      confirmedAt: new Date(),
    });
    await db.insert(sentMessage).values(
      Array.from({ length: 50 }, () => ({
        workspaceId: target.workspaceId,
        destinationId: target.id,
        type: "email" as const,
        sentAt: new Date(),
      })),
    );
    let mailed = 0;
    const email = {
      send: () => {
        mailed += 1;
        return Promise.resolve();
      },
    };

    const result = await sendTestAlert(db, target, { senders: senders({ email }), appUrl, emailCapped: true });

    expect(result).toEqual({ status: "capped" });
    expect(mailed).toBe(0);
    expect(await stored(target.id)).toMatchObject({ lastError: null });
  });
});
