import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.ts";

/** A Drizzle client over a pg pool. Pass `loadConfig().databaseUrl` from `@watchdog/core`. */
export function createDb(databaseUrl: string) {
  return drizzle(databaseUrl, { schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * Ends a Drizzle client's pool and resolves once every connection's socket has closed.
 * `pool.end()` alone resolves as soon as the pool's client list is empty, before the sockets close
 * (pg-pool 3.14 `_remove`). Stopping Postgres in that window sends the open connection a FATAL
 * 57P01, which the pool re-emits as an unhandled `error`. Each `remove` event fires from the
 * client's `end` callback, after its socket has closed.
 */
export async function closeDb({ $client: pool }: { $client: Pool }) {
  let open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) resolve();
    pool.on("remove", () => {
      open -= 1;
      if (open === 0) resolve();
    });
  });
  await pool.end();
  await closed;
}
