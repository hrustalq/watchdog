import { telegramLoginQueue, telegramRevokeQueue } from "@watchdog/core";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { migrate } from "@watchdog/db";
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
});
