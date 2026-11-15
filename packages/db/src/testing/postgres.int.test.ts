import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { startPostgres, type TestPostgres } from "./postgres.ts";

async function query<Row extends object>(url: string, text: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<Row>(text)).rows;
  } finally {
    await client.end();
  }
}

describe("startPostgres", () => {
  let postgres: TestPostgres;

  // The returned teardown runs only if the database was created.
  beforeAll(async () => {
    postgres = await startPostgres();
    return postgres.stop;
  }, 120_000);

  it("serves queries on the returned URL", async () => {
    expect(await query(postgres.url, "select 1 as one")).toEqual([{ one: 1 }]);
  });

  // Four packages each starting a container per test file starved one machine (#436), so a run
  // starts one server per package and a test file gets a database of its own on it.
  it("gives each caller its own database on the run's one server, and drops it on stop", async () => {
    const other = await startPostgres();
    try {
      expect(new URL(other.url).host).toBe(new URL(postgres.url).host);
      expect(new URL(other.url).pathname).not.toBe(new URL(postgres.url).pathname);
      await query(other.url, "create table only_here (id int)");
      expect(await query(postgres.url, "select to_regclass('only_here') as found")).toEqual([{ found: null }]);
    } finally {
      await other.stop();
    }
    const name = new URL(other.url).pathname.slice(1);
    expect(await query(postgres.url, `select 1 from pg_database where datname = '${name}'`)).toEqual([]);
  });
});
