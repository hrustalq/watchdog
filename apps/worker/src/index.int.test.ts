import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
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
});
