import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./postgres.ts";

describe("startPostgres", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await postgres.stop();
  });

  it("serves queries on the returned URL", async () => {
    const client = new pg.Client({ connectionString: postgres.url });
    await client.connect();
    try {
      const result = await client.query<{ one: number }>("select 1 as one");
      expect(result.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.end();
    }
  });
});
