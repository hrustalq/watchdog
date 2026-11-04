import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { closeDb, createDb } from "../client.ts";

// The Postgres in Compose (#8) must run the same major version.
export const postgresImage = "postgres:18-alpine";

export interface TestPostgres {
  url: string;
  stop: () => Promise<void>;
}

/** Starts a throwaway Postgres container for an integration test. Needs Docker. */
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer(postgresImage).start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * Applies only the first `count` migrations, to build a database as it stood then. It reads a copy
 * of migrations/ whose journal stops there.
 */
export async function migrateFirst(databaseUrl: string, count: number): Promise<void> {
  const migrationsFolder = await mkdtemp(path.join(tmpdir(), "watchdog-migrations-"));
  const db = createDb(databaseUrl);
  try {
    await cp(path.join(import.meta.dirname, "../../migrations"), migrationsFolder, { recursive: true });
    const journalPath = path.join(migrationsFolder, "meta/_journal.json");
    const firstEntries = (key: string, value: unknown): unknown =>
      key === "entries" && Array.isArray(value) ? value.slice(0, count) : value;
    const journal = await readFile(journalPath, "utf8");
    await writeFile(journalPath, JSON.stringify(JSON.parse(journal, firstEntries)));
    await applyMigrations(db, { migrationsFolder });
  } finally {
    await closeDb(db);
    await rm(migrationsFolder, { recursive: true, force: true });
  }
}
