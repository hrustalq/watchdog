import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb } from "./client.ts";
import { startPostgres, type TestPostgres } from "./testing/postgres.ts";

describe("closeDb", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
    return postgres.stop;
  }, 120_000);

  it("resolves only after every pooled connection has closed", async () => {
    const db = createDb(postgres.url);
    let open = 0;
    db.$client.on("connect", () => (open += 1));
    db.$client.on("remove", () => (open -= 1));
    await Promise.all([1, 2, 3].map(() => db.execute(sql`select pg_sleep(0.05)`)));
    expect(open).toBe(3);

    await closeDb(db);
    expect(open).toBe(0);
  });

  it("resolves at once for a client that never connected", async () => {
    const db = createDb(postgres.url);
    await closeDb(db);
    expect(db.$client.totalCount).toBe(0);
  });
});
