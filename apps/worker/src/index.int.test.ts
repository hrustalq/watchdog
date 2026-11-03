import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, eq, migrate, source, user, workspace } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readyFile } from "./ready.ts";

// Each worker gets its own temp dir, so its ready file can't collide with a local dev worker's.
const tmp = mkdtempSync(path.join(tmpdir(), "worker-test-"));
const ready = path.join(tmp, path.basename(readyFile));

// A test that fails before stop() must not leave its worker running after Postgres is gone.
const running = new Set<ChildProcess>();
afterEach(() => {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
});

/** Runs the worker the way its container does, until it logs that it's ready. */
async function startWorker(databaseUrl: string) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "index.ts")], {
    // Only what the worker needs, so a developer's own environment can't leak in.
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmp,
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: "a-test-secret-of-at-least-32-characters",
      BETTER_AUTH_URL: "http://localhost:3000",
      // The test's feed server listens on loopback, which the egress guard blocks by default.
      EGRESS_ALLOWLIST: "127.0.0.1",
    },
  });
  running.add(child);
  child.once("exit", () => running.delete(child));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => {
      if (output.includes("Worker ready")) resolve();
    });
    child.once("exit", () => {
      reject(new Error(`Worker exited before it was ready:\n${output}`));
    });
  });
  return {
    output: () => output,
    /** Sends SIGTERM the way `docker compose stop` does, and resolves with the exit code. */
    stop: async () => {
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      return exited;
    },
  };
}

async function databaseState(url: string) {
  const db = createDb(url);
  try {
    const applied = await db.$client.query<{ hash: string; created_at: string }>(
      "select hash, created_at from drizzle.__drizzle_migrations order by id",
    );
    const pgboss = await db.$client.query<{ name: string }>(
      "select schema_name as name from information_schema.schemata where schema_name = 'pgboss'",
    );
    return { applied: applied.rows, pgboss: pgboss.rows.length === 1 };
  } finally {
    await db.$client.end();
  }
}

describe("worker", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
    return postgres.stop;
  }, 120_000);

  it("migrates, starts pg-boss and reports ready, then stops pg-boss cleanly on SIGTERM", async () => {
    const worker = await startWorker(postgres.url);
    const state = await databaseState(postgres.url);
    expect(state.applied.length).toBeGreaterThan(0);
    expect(state.pgboss).toBe(true);
    expect(existsSync(ready)).toBe(true);

    expect(await worker.stop()).toBe(0);
    expect(worker.output()).toContain("pg-boss stopped");
    expect(existsSync(ready)).toBe(false);
  }, 60_000);

  it("doesn't re-run applied migrations when it starts again", async () => {
    const before = await databaseState(postgres.url);
    expect(before.applied.length).toBeGreaterThan(0);

    const worker = await startWorker(postgres.url);
    expect(await databaseState(postgres.url)).toEqual(before);
    expect(await worker.stop()).toBe(0);
  }, 60_000);

  it("polls a new Source at start, and lets the poll finish when stopped mid-poll", async () => {
    // A feed that answers after 3 s, so the worker is stopped while the poll is running.
    let requested = false;
    const server = createServer((_request, response) => {
      requested = true;
      setTimeout(() => {
        response.setHeader("content-type", "application/rss+xml");
        response.end(
          `<?xml version="1.0"?><rss version="2.0"><channel><title>Slow</title>` +
            `<item><guid>one</guid><title>One</title><description>An entry.</description></item>` +
            `</channel></rss>`,
        );
      }, 3000);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("The server has no port");
    const { port } = address;

    await migrate(postgres.url);
    const db = createDb(postgres.url);
    try {
      await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
      const [ws] = await db
        .insert(workspace)
        .values({ name: "Workspace", ownerUserId: "owner" })
        .returning();
      const [src] = await db
        .insert(source)
        .values({
          workspaceId: ws?.id ?? "",
          type: "rss",
          name: "Slow feed",
          config: { url: `http://127.0.0.1:${String(port)}/feed.rss` },
          schedule: "*/15 * * * *",
        })
        .returning();
      const sourceId = src?.id ?? "";
      const added = new Date();

      const worker = await startWorker(postgres.url);
      await vi.waitFor(() => { expect(requested).toBe(true); }, { timeout: 30_000, interval: 100 });
      expect(await worker.stop()).toBe(0);

      const polled = await db.query.source.findFirst({ where: eq(source.id, sourceId) });
      expect(polled?.lastError).toBeNull();
      expect(polled?.lastPolledAt?.getTime()).toBeGreaterThan(added.getTime());
      expect(polled?.nextPollAt.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await db.$client.end();
      server.close();
    }
  }, 60_000);
});
