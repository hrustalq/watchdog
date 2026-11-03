import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { closeDb } from "./client.ts";

/**
 * Applies the pending migrations from packages/db/migrations and skips the applied ones, keeping
 * the same log as `db:migrate` (drizzle-kit migrate). It takes no lock, so run one at a time.
 */
export async function migrate(databaseUrl: string): Promise<void> {
  // Resolved here, not on import, so code that bundles @watchdog/db for createDb never runs it.
  const migrationsFolder = path.join(import.meta.dirname, "../migrations");
  const db = drizzle(databaseUrl);
  try {
    await applyMigrations(db, { migrationsFolder });
  } finally {
    await closeDb(db);
  }
}
