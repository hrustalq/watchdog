import { randomBytes } from "node:crypto";
import { encryptSecret, telegramLoginQueue, telegramRevokeQueue } from "@watchdog/core";
import { revokeSession } from "@watchdog/core/telegram-session";
import { closeDb, createDb, eq, migrate, telegramSession, user, workspace } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionQueue, startTelegramSessions } from "./telegram-session.ts";

const waitLong = { timeout: 30_000, interval: 100 };

describe("the Telegram user session jobs", () => {
  let postgres: TestPostgres;
  let boss: PgBoss;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
  }, 120_000);

  // Its own pg-boss each, so one test's workers can't take the next one's jobs.
  beforeEach(async () => {
    boss = new PgBoss({ connectionString: postgres.url, supervise: false, schedule: false });
    await boss.start();
  });

  afterEach(async () => {
    await boss.stop({ timeout: 1_000 });
  });

  afterAll(async () => {
    await postgres.stop();
  });

  it("runs a login until the worker stops, never retries one, and runs revokes", async () => {
    const logins: string[] = [];
    const revokes: string[] = [];
    const stop = await startTelegramSessions(boss, {
      login: async (id, signal) => {
        logins.push(id);
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        throw new Error("the worker stopped");
      },
      revoke: (id) => {
        revokes.push(id);
        return Promise.resolve();
      },
      session: () => Promise.resolve(),
      live: () => Promise.resolve([]),
    });

    const jobId = await boss.send(telegramLoginQueue, { id: "login-1" });
    await boss.send(telegramRevokeQueue, { id: "session-1" });
    await vi.waitFor(() => {
      expect(logins).toEqual(["login-1"]);
      expect(revokes).toEqual(["session-1"]);
    }, waitLong);

    stop();
    await vi.waitFor(async () => {
      expect((await boss.findJobs(telegramLoginQueue, { id: jobId ?? "" }))[0]?.state).toBe("failed");
    }, waitLong);
    expect(logins).toEqual(["login-1"]);
  });

  it("runs one turn per live session, however often the tick comes, and ends it when the worker stops", async () => {
    const open = new Map<string, number>();
    const started: string[] = [];
    const stop = await startTelegramSessions(boss, {
      login: () => Promise.resolve(),
      revoke: () => Promise.resolve(),
      live: () => Promise.resolve([{ id: "session-a" }, { id: "session-b" }]),
      session: async (id, signal, until) => {
        started.push(id);
        open.set(id, (open.get(id) ?? 0) + 1);
        expect(until.getTime()).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
        open.set(id, (open.get(id) ?? 0) - 1);
      },
    });
    await vi.waitFor(() => {
      expect(started.toSorted()).toEqual(["session-a", "session-b"]);
    }, waitLong);

    // The minute's tick again, while both turns run.
    await boss.send("telegram-session-tick");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(started).toHaveLength(2);

    stop();
    await vi.waitFor(() => {
      expect([...open.values()]).toEqual([0, 0]);
    }, waitLong);
    await vi.waitFor(async () => {
      expect((await boss.findJobs(sessionQueue)).map(({ state }) => state)).toEqual(["completed", "completed"]);
    }, waitLong);
  });

  /** A Workspace with the one session a revoke acts on, and nothing watching it. */
  async function revoking(db: ReturnType<typeof createDb>, owner: string, secret: string) {
    await db.insert(user).values({ id: owner, name: owner, email: `${owner}@example.com` });
    const [space] = await db.insert(workspace).values({ name: owner, ownerUserId: owner }).returning();
    const [session] = await db
      .insert(telegramSession)
      .values({ workspaceId: space?.id ?? "", account: "Ada", secretCiphertext: secret })
      .returning({ id: telegramSession.id });
    return session?.id ?? "";
  }

  it("completes a revoke whose session it can't decrypt, instead of retrying it forever", async () => {
    const db = createDb(postgres.url);
    // The session as a change of WATCHDOG_ENCRYPTION_KEY leaves it: stored under another key.
    const sessionId = await revoking(db, "changed-key", encryptSecret("the session", randomBytes(32)));
    const stop = await startTelegramSessions(boss, {
      login: () => Promise.resolve(),
      revoke: (id) =>
        revokeSession(
          db,
          {
            encryptionKey: randomBytes(32),
            createClient: () => {
              throw new Error("the revoke tried to reach Telegram with a session it can't read");
            },
          },
          id,
        ),
      session: () => Promise.resolve(),
      live: () => Promise.resolve([]),
    });

    const jobId = await boss.send(telegramRevokeQueue, { id: sessionId });
    await vi.waitFor(async () => {
      expect((await boss.findJobs(telegramRevokeQueue, { id: jobId ?? "" }))[0]?.state).toBe("completed");
    }, waitLong);
    const [job] = await boss.findJobs(telegramRevokeQueue, { id: jobId ?? "" });
    // No second attempt: the first one ended the job.
    expect(job).toMatchObject({ state: "completed", retryCount: 0 });
    const [row] = await db.select().from(telegramSession).where(eq(telegramSession.id, sessionId));
    expect(row?.unreadableAt).toBeInstanceOf(Date);

    stop();
    await closeDb(db);
  }, 60_000);

  it("retries a revoke that failed for any other reason, as an unreachable Telegram does", async () => {
    const db = createDb(postgres.url);
    const key = randomBytes(32);
    const sessionId = await revoking(db, "unreachable", encryptSecret("the session", key));
    const stop = await startTelegramSessions(boss, {
      login: () => Promise.resolve(),
      // What revokeSession throws when Telegram doesn't answer; packages/core's login test pins that.
      revoke: () => Promise.reject(new Error("Telegram didn't answer")),
      session: () => Promise.resolve(),
      live: () => Promise.resolve([]),
    });

    const jobId = await boss.send(telegramRevokeQueue, { id: sessionId });
    await vi.waitFor(async () => {
      expect((await boss.findJobs(telegramRevokeQueue, { id: jobId ?? "" }))[0]?.state).toBe("retry");
    }, waitLong);
    const [row] = await db.select().from(telegramSession).where(eq(telegramSession.id, sessionId));
    // The session is kept for the retry, and not marked unreadable.
    expect(row?.unreadableAt).toBeNull();

    stop();
    await closeDb(db);
  }, 60_000);
});
