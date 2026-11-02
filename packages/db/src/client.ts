import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.ts";

/** A Drizzle client over a pg pool. Pass `loadConfig().databaseUrl` from `@watchdog/core`. */
export function createDb(databaseUrl: string) {
  return drizzle(databaseUrl, { schema });
}

export type Db = ReturnType<typeof createDb>;
