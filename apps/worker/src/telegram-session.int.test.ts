import { telegramLoginQueue, telegramRevokeQueue } from "@watchdog/core";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { migrate } from "@watchdog/db";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTelegramSessions } from "./telegram-session.ts";

const waitLong = { timeout: 30_000, interval: 100 };

describe("the Telegram user session jobs", () => {
  let postgres: TestPostgres;
  let boss: PgBoss;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    boss = new PgBoss({ connectionString: postgres.url, supervise: false, schedule: false });
    await boss.start();
  }, 120_000);

  afterAll(async () => {
    await boss.stop({ timeout: 1_000 });
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
});
