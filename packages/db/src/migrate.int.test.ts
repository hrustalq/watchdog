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

/**
 * What one `pnpm` start may take here. Each call is a pnpm and drizzle-kit start; a loaded runner charged
 * two of them more than the 120 s a whole test was given, while the file ran in 29.2 s idle and a single
 * `generate` took 34 s (#433). The call is bounded by this, so a start that really hangs fails as the
 * call that hung, with its own error.
 */
const callBudget = 120_000;

/**
 * A test's deadline, counted from the calls it makes rather than picked: every `pnpm` call it waits for
 * gets `callBudget`, and the test outlives them by a margin, so load may slow the work the test names and
 * a hang still fails it. Both tests here make two calls, so each gets 250 s rather than a flat number the
 * next loaded run outgrows.
 */
const testBudget = (calls: number) => calls * callBudget + 10_000;

/** Runs pnpm in packages/db against the given database, the way a developer would. */
async function pnpm(args: string[], databaseUrl: string) {
  return promisify(execFile)("pnpm", args, {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: callBudget,
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

/**
 * The drizzle-kit starts are the file's own work: they warm the cold pnpm start on the hook's budget, and
 * each test's deadline counts the calls it makes (`testBudget`), so load may slow them, a hang still fails.
 */
describe("drizzle-kit", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
    // Whatever a test runs first pays a cold pnpm and drizzle-kit start, which is the fixed part of its cost
    // and the part a busy runner stretches most. Warm it here, on the hook's budget, so the tests time their
    // own work rather than the module load before it.
    await pnpm(["exec", "drizzle-kit", "--version"], postgres.url);
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
  }, testBudget(2));

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
  }, testBudget(2));
});
