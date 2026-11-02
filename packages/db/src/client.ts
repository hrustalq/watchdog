import { drizzle } from "drizzle-orm/node-postgres";

/** A Drizzle client over a pg pool. Pass `loadConfig().databaseUrl` from `@watchdog/core`. */
export function createDb(databaseUrl: string) {
  return drizzle(databaseUrl);
}
