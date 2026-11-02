import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate.ts";
import { startPostgres, type TestPostgres } from "./testing/postgres.ts";

const packageDir = path.join(import.meta.dirname, "..");
const migrationsDir = path.join(packageDir, "migrations");

/** Every table outside the system schemas, plus the rows of Drizzle's migrations log. */
async function databaseState(url: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const tables = await client.query<{ name: string }>(
      `select table_schema || '.' || table_name as name from information_schema.tables
       where table_schema not in ('pg_catalog', 'information_schema') order by 1`,
    );
    const applied = await client.query<{ hash: string; created_at: string }>(
      "select hash, created_at from drizzle.__drizzle_migrations order by id",
    );
    return { tables: tables.rows.map((row) => row.name), applied: applied.rows };
  } finally {
    await client.end();
  }
}

/** Runs a command in packages/db against the given database, the way a developer would. */
async function inPackage(command: string, args: string[], databaseUrl: string) {
  return promisify(execFile)(command, args, {
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
  });
});

describe("drizzle-kit", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
    return postgres.stop;
  }, 120_000);

  it("db:migrate applies every migration to an empty database, and a second run changes nothing", async () => {
    await inPackage("pnpm", ["run", "db:migrate"], postgres.url);
    const first = await databaseState(postgres.url);
    expect(first.applied.length).toBeGreaterThan(0);

    await inPackage("pnpm", ["run", "db:migrate"], postgres.url);
    expect(await databaseState(postgres.url)).toEqual(first);
  }, 60_000);

  it("leaves the pgboss schema alone on generate and push", async () => {
    await migrate(postgres.url);
    const boss = new PgBoss(postgres.url);
    await boss.start();
    await boss.stop();
    const before = await databaseState(postgres.url);
    expect(before.tables.some((name) => name.startsWith("pgboss."))).toBe(true);
    const migrations = await readdir(migrationsDir, { recursive: true });

    await inPackage("pnpm", ["run", "db:generate"], postgres.url);
    expect(await readdir(migrationsDir, { recursive: true })).toEqual(migrations);

    // --force approves data loss without a prompt, so a push that wanted pgboss gone would drop it.
    await inPackage("pnpm", ["exec", "drizzle-kit", "push", "--force"], postgres.url);
    expect(await databaseState(postgres.url)).toEqual(before);
  }, 60_000);
});
