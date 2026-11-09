import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./postgres.ts";

describe("startPostgres", () => {
  let postgres: TestPostgres;

  // The returned teardown runs only if the container started.
  beforeAll(async () => {
    postgres = await startPostgres();
    return postgres.stop;
  }, 120_000);

  it("serves queries on the returned URL", async () => {
    const client = new Client({ connectionString: postgres.url });
    await client.connect();
    try {
      const result = await client.query<{ one: number }>("select 1 as one");
      expect(result.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.end();
    }
  });
});
