import { closeDb, createDb, type Db, migrate } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { PgBoss } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { botQueue, startTelegramBot } from "./telegram.ts";

const waitLong = { timeout: 30_000, interval: 100 };

describe("the Telegram bot's job", () => {
  let postgres: TestPostgres;
  let db: Db;
  const bosses: PgBoss[] = [];

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  afterEach(async () => {
    await Promise.all(bosses.splice(0).map((boss) => boss.stop({ timeout: 1_000 })));
    await db.$client.query("delete from pgboss.job where name = $1", [botQueue]);
  });

  async function newBoss() {
    const boss = new PgBoss({ connectionString: postgres.url, supervise: false, schedule: false });
    await boss.start();
    bosses.push(boss);
    return boss;
  }

  /** A runner that holds a loop until its signal ends, counting the loops open at once. */
  function loops() {
    const seen = { started: 0, open: 0, mostOpen: 0 };
    const run = async (signal: AbortSignal) => {
      seen.started += 1;
      seen.open += 1;
      seen.mostOpen = Math.max(seen.mostOpen, seen.open);
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      seen.open -= 1;
    };
    return { seen, run };
  }

  const activeJobs = async () =>
    (
      await db.$client.query<{ state: string }>("select state from pgboss.job where name = $1 and state <= 'active'", [
        botQueue,
      ])
    ).rows.map(({ state }) => state);

  it("runs one loop when two workers start together", async () => {
    const { seen, run } = loops();
    const [first, second] = await Promise.all([newBoss(), newBoss()]);

    await Promise.all([startTelegramBot(first, run), startTelegramBot(second, run)]);
    await vi.waitFor(() => { expect(seen.started).toBe(1); }, waitLong);
    // Long enough for the second worker's own polls of the queue, which come every 2 seconds.
    await new Promise((resolve) => setTimeout(resolve, 5_000));

    expect(seen.mostOpen).toBe(1);
    expect(await activeJobs()).toEqual(["active"]);
  });

  it("ends the loop at once when stopped, so stopping pg-boss doesn't wait out its grace period", async () => {
    const { seen, run } = loops();
    const boss = await newBoss();
    const stop = await startTelegramBot(boss, run);
    await vi.waitFor(() => { expect(seen.open).toBe(1); }, waitLong);

    stop();
    const stopping = Date.now();
    await boss.stop();

    expect(seen.open).toBe(0);
    expect(Date.now() - stopping).toBeLessThan(20_000);
    const finished = await db.$client.query<{ state: string }>("select state from pgboss.job where name = $1", [botQueue]);
    expect(finished.rows.map(({ state }) => state)).toEqual(["completed"]);
  });

  it("starts the loop again after a worker that stopped", async () => {
    const { seen, run } = loops();
    const boss = await newBoss();
    const stop = await startTelegramBot(boss, run);
    await vi.waitFor(() => { expect(seen.open).toBe(1); }, waitLong);
    stop();
    await boss.stop();

    await startTelegramBot(await newBoss(), run);

    await vi.waitFor(() => { expect(seen.started).toBe(2); }, waitLong);
  });
});
