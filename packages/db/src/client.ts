import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.ts";

// Each pool's connected clients, from its connect event to its remove event.
const connected = new WeakMap<Pool, Set<PoolClient>>();

/**
 * How long a connection may take to open before the caller's failure path runs. pg's default is 0, which
 * waits forever, so a database that drops packets (a failover, a partition) hangs every query rather than
 * refusing it. Five seconds is well under the bot runner's 15 second retry and the jobs' egress timeouts.
 *
 * pg applies this limit to two waits: opening a socket, and taking a free client from a busy pool. The
 * second is why it isn't shorter. A send holds its connection for the whole send, up to the egress guard's
 * 30 seconds, and the delivery pool runs 20 sends and digests beside the pipeline. A caller that waits this
 * long fails instead of hanging, and its pg-boss job is retried, so a slow burst costs a retry, not a send.
 * A statement or query timeout is deliberately not set: a delivery's `for update` waits on a row whose send
 * can run for minutes, and aborting that work would lose a send that only needed to wait.
 */
const connectionTimeoutMillis = 5_000;

/**
 * TCP keepalive, so a connection that dies after it opened is noticed instead of holding a query forever.
 * Node probes a connection idle for this long; the system's probe interval and count then decide when the
 * socket gives up, after which the query in flight rejects.
 */
const keepAliveInitialDelayMillis = 10_000;

/** A Drizzle client over a pg pool. Pass `loadConfig().databaseUrl` from `@watchdog/core`. */
export function createDb(databaseUrl: string) {
  const db = drizzle({
    connection: {
      connectionString: databaseUrl,
      connectionTimeoutMillis,
      keepAlive: true,
      keepAliveInitialDelayMillis,
    },
    schema,
  });
  const clients = new Set<PoolClient>();
  connected.set(db.$client, clients);
  db.$client.on("connect", (client) => clients.add(client));
  db.$client.on("remove", (client) => clients.delete(client));
  return db;
}

export type Db = ReturnType<typeof createDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
