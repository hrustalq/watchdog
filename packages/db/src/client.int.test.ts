import { createServer, Socket } from "node:net";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, createDb } from "./client.ts";
import { startPostgres, type TestPostgres } from "./testing/postgres.ts";

/** A port that accepts a connection and never answers, the way a database behind a black hole does. */
async function silentPort() {
  const accepted = new Set<Socket>();
  const server = createServer((socket) => {
    accepted.add(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The silent server has no port");
  return {
    port: address.port,
    stop: () =>
      new Promise<void>((resolve) => {
        // A socket still open would hold the server's close, and the test, up.
        for (const socket of accepted) socket.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Every message the query's failure carries, from drizzle's own to the socket's, which is the deepest. */
function failureMessages(error: unknown): string[] {
  const messages: string[] = [];
  let next = error;
  while (next instanceof Error) {
    messages.push(next.message);
    next = next.cause;
  }
  return messages;
}

describe("the database client", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
    return postgres.stop;
  }, 120_000);

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("closeDb", () => {
    it("resolves only after every pooled connection has closed", async () => {
      const db = createDb(postgres.url);
      let open = 0;
      db.$client.on("connect", () => (open += 1));
      db.$client.on("remove", () => (open -= 1));
      await Promise.all([1, 2, 3].map(() => db.execute(sql`select pg_sleep(0.05)`)));
      expect(open).toBe(3);

      await closeDb(db);
      expect(open).toBe(0);
    });

    it("resolves at once for a client that never connected", async () => {
      const db = createDb(postgres.url);
      await closeDb(db);
      expect(db.$client.totalCount).toBe(0);
    });
  });

  describe("a database that doesn't answer", () => {
    it("fails a connect within a few seconds, instead of hanging", async () => {
      const silent = await silentPort();
      const unreachable = createDb(`postgres://watchdog:secret@127.0.0.1:${String(silent.port)}/watchdog`);
      const started = performance.now();
      try {
        // The pool gives up after 5 seconds. A query that never rejects fails this test on its timeout,
        // and the ceiling is generous so a loaded runner isn't mistaken for a hang.
        const error = await unreachable.execute(sql`select 1`).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        expect(failureMessages(error).join(" | ")).toMatch(/connection timeout/i);
        expect(performance.now() - started).toBeLessThan(15_000);
      } finally {
        await closeDb(unreachable);
        await silent.stop();
      }
    }, 30_000);

    it("keeps an open connection alive, so one the network drops is noticed", async () => {
      const keepAlive = vi.spyOn(Socket.prototype, "setKeepAlive");
      const db = createDb(postgres.url);
      try {
        await db.execute(sql`select 1`);
        // Node probes a socket idle for 10 seconds, which is what notices a connection that died after it opened.
        expect(keepAlive).toHaveBeenCalledWith(true, 10_000);
      } finally {
        await closeDb(db);
        keepAlive.mockRestore();
      }
    });
  });
});
