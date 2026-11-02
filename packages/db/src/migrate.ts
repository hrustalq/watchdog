import path from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";

const migrationsFolder = path.join(import.meta.dirname, "../migrations");

/**
 * Applies the pending migrations from packages/db/migrations. Already applied ones are skipped,
 * so it is safe to run on every start. `db:migrate` (drizzle-kit migrate) keeps the same log.
 */
export async function migrate(databaseUrl: string): Promise<void> {
  const db = drizzle(databaseUrl);
  try {
    await applyMigrations(db, { migrationsFolder });
  } finally {
    await db.$client.end();
  }
}
