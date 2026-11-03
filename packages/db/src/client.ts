import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.ts";

// Each pool's connected clients, from its connect event to its remove event.
const connected = new WeakMap<Pool, Set<PoolClient>>();

/** A Drizzle client over a pg pool. Pass `loadConfig().databaseUrl` from `@watchdog/core`. */
export function createDb(databaseUrl: string) {
  const db = drizzle(databaseUrl, { schema });
  const clients = new Set<PoolClient>();
  connected.set(db.$client, clients);
  db.$client.on("connect", (client) => clients.add(client));
  db.$client.on("remove", (client) => clients.delete(client));
  return db;
}

export type Db = ReturnType<typeof createDb>;

/**
 * Ends the pool and resolves once every connection's socket has closed. `pool.end()` alone
 * resolves as soon as the pool's client list is empty, before the sockets close (pg-pool 3.14
 * `_remove`). Stopping Postgres in that window sends the open connection a FATAL 57P01, which the
 * pool re-emits as an unhandled `error`. A client's `remove` event fires once its socket has
 * closed. A client whose connect failed never joins the set, so closeDb never waits on it.
 */
export async function closeDb(db: Db) {
  const pool = db.$client;
  const clients = connected.get(pool) ?? new Set();
  const closed = new Promise<void>((resolve) => {
    // Registered after createDb's listener, so the client has already left the set.
    const settle = () => {
      if (clients.size > 0) return;
      pool.off("remove", settle);
      resolve();
    };
    pool.on("remove", settle);
    settle();
  });
  await pool.end();
  await closed;
}
