import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { PgBoss } from "pg-boss";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { startPostgres, type TestPostgres } from "./testing/postgres.ts";

const packageDir = path.join(import.meta.dirname, "..");
const migrationsDir = path.join(packageDir, "migrations");

/** Every column and index outside the system schemas, plus the rows of Drizzle's migrations log. */
async function databaseState(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const columns = await client.query<{ name: string }>(
      `select table_schema || '.' || table_name || '.' || column_name || ' ' || data_type as name
       from information_schema.columns
       where table_schema not in ('pg_catalog', 'information_schema') order by 1`,
    );
    const indexes = await client.query<{ name: string }>(
      `select indexdef as name from pg_indexes
       where schemaname not in ('pg_catalog', 'information_schema') order by 1`,
    );
    const applied = await client.query<{ hash: string; created_at: string }>(
      "select hash, created_at from drizzle.__drizzle_migrations order by id",
    );
    return {
      columns: columns.rows.map((row) => row.name),
      indexes: indexes.rows.map((row) => row.name),
      applied: applied.rows,
    };
  } finally {
    await client.end();
  }
}

/** The pgboss schema's part of a database state. */
function pgbossState({ columns, indexes }: Awaited<ReturnType<typeof databaseState>>) {
  return {
    columns: columns.filter((name) => name.startsWith("pgboss.")),
    indexes: indexes.filter((definition) => definition.includes(" ON pgboss.")),
  };
}

/** Runs pnpm in packages/db against the given database, the way a developer would. */
async function pnpm(args: string[], databaseUrl: string) {
  return promisify(execFile)("pnpm", args, {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

describe("migrate", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
    return postgres.stop;
  }, 120_000);

  it("applies every migration to an empty database, and a second run changes nothing", async () => {
    await migrate(postgres.url);
    const first = await databaseState(postgres.url);
    expect(first.applied.length).toBeGreaterThan(0);

    await migrate(postgres.url);
    expect(await databaseState(postgres.url)).toEqual(first);
  }, 60_000);
});

describe("drizzle-kit", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
    return postgres.stop;
  }, 120_000);

  it("db:migrate applies every migration to an empty database, and a second run changes nothing", async () => {
    await pnpm(["run", "db:migrate"], postgres.url);
    const first = await databaseState(postgres.url);
    expect(first.applied.length).toBeGreaterThan(0);

    await pnpm(["run", "db:migrate"], postgres.url);
    expect(await databaseState(postgres.url)).toEqual(first);

    // migrate() at worker boot reads the same log, so it finds nothing to apply either.
    await migrate(postgres.url);
    expect(await databaseState(postgres.url)).toEqual(first);
  }, 60_000);

  it("leaves the pgboss schema alone on generate and push", async () => {
    await migrate(postgres.url);
    const boss = new PgBoss(postgres.url);
    await boss.start();
    await boss.stop();
    const before = await databaseState(postgres.url);
    expect(pgbossState(before).columns).not.toEqual([]);
    expect(pgbossState(before).indexes).not.toEqual([]);
    const migrations = await readdir(migrationsDir, { recursive: true });

    await pnpm(["run", "db:generate"], postgres.url);
    expect(await readdir(migrationsDir, { recursive: true })).toEqual(migrations);

    // --force approves data loss without a prompt, so a push that wanted pgboss gone would drop it.
    // Only pgboss is compared: drizzle-kit 0.31 misreads public's composite unique keys and
    // re-creates them on push, which can leave one dropped. Public changes go through migrations.
    await pnpm(["exec", "drizzle-kit", "push", "--force"], postgres.url);
    expect(pgbossState(await databaseState(postgres.url))).toEqual(pgbossState(before));
  }, 60_000);
});
