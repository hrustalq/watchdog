import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { tmpdir } from "node:os";
import path from "node:path";
import { agentItemQueue, itemEnqueuer, pollSource, processItemQueue } from "@watchdog/core";
import {
  action,
  agentCall,
  classifier,
  closeDb,
  createDb,
  type Db,
  delivery,
  destination,
  eq,
  item,
  itemCategory,
  itemLog,
  migrate,
  modelConfig,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { PgBoss } from "pg-boss";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { deliverQueue, deliveryEnqueuer } from "./delivery.ts";
import { readyFile } from "./ready.ts";
import { botQueue } from "./telegram.ts";

// Each worker gets its own temp dir, so its ready file can't collide with a local dev worker's.
const tmp = mkdtempSync(path.join(tmpdir(), "worker-test-"));
const ready = path.join(tmp, path.basename(readyFile));

// A test that fails before stop() must not leave its worker running after Postgres is gone.
const running = new Set<ChildProcess>();
afterEach(() => {
  for (const child of running) child.kill("SIGKILL");
  running.clear();
});

/**
 * How long a spawned worker may take to log that it's ready. Its boot is a cold migration run, a pg-boss
 * start and the routers it builds: the whole file takes 19.7 s alone, and the first worker of a loaded full
 * run was cut at 60,190 ms by the deadline it shared with every other test here (#426). So the wait has a
 * bound of its own, and it names the worker's own output when that expires.
 */
const readyBudget = 120_000;

/**
 * A test here outlives the worker it starts by a minute, so the wait above is the one that reports a worker
 * that never came up, not the test's own deadline.
 */
const bootBudget = readyBudget + 60_000;

/** Runs the worker the way its container does, until it logs that it's ready. */
async function startWorker(databaseUrl: string, extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "index.ts")], {
    // Only what the worker needs, so a developer's own environment can't leak in.
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmp,
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: "a-test-secret-of-at-least-32-characters",
      BETTER_AUTH_URL: "http://localhost:3000",
      WATCHDOG_ENCRYPTION_KEY: "A".repeat(43) + "=",
      // The test's feed server listens on loopback, which the egress guard blocks by default.
      EGRESS_ALLOWLIST: "127.0.0.1",
      ...extraEnv,
    },
  });
  running.add(child);
  child.once("exit", () => running.delete(child));
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  await new Promise<void>((resolve, reject) => {
    const late = setTimeout(() => {
      reject(new Error(`Worker didn't report ready within ${String(readyBudget / 1000)} s:\n${output}`));
    }, readyBudget);
    const settle = () => {
      clearTimeout(late);
    };
    child.stdout.on("data", () => {
      if (!output.includes("Worker ready")) return;
      settle();
      resolve();
    });
    // "close", not "exit": a process can exit before its last output has been read.
    child.once("close", () => {
      settle();
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
    /** Kills it with no chance to clean up, as a crash or an out-of-memory kill does. */
    kill: async () => {
      const exited = new Promise<void>((resolve) => child.once("exit", () => { resolve(); }));
      child.kill("SIGKILL");
      await exited;
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
    await closeDb(db);
  }
}

/** How many Telegram bot queues exist. A worker with no bot token has no runner, so it makes none. */
async function telegramBotQueues(url: string) {
  const db = createDb(url);
  try {
    const { rows } = await db.$client.query("select name from pgboss.queue where name = $1", [botQueue]);
    return rows.length;
  } finally {
    await closeDb(db);
  }
}

describe("worker", () => {
  let postgres: TestPostgres;

  beforeAll(async () => {
    postgres = await startPostgres();
    return postgres.stop;
  }, 120_000);

  it("migrates, starts pg-boss and reports ready without a bot runner, then stops pg-boss cleanly on SIGTERM", async () => {
    const worker = await startWorker(postgres.url);
    const state = await databaseState(postgres.url);
    expect(state.applied.length).toBeGreaterThan(0);
    expect(state.pgboss).toBe(true);
    expect(existsSync(ready)).toBe(true);
    expect(await telegramBotQueues(postgres.url)).toBe(0);

    // Idle, it stops at once: well inside pg-boss's 30 s wait for running jobs, which a regression would hit.
    const stopping = Date.now();
    expect(await worker.stop()).toBe(0);
    expect(Date.now() - stopping).toBeLessThan(20_000);
    expect(worker.output()).toContain("pg-boss stopped");
    expect(existsSync(ready)).toBe(false);
  }, bootBudget);

  it("stops at boot on a malformed TELEGRAM_BOT_TOKEN, naming the variable and not its value", async () => {
    const start = startWorker(postgres.url, { TELEGRAM_BOT_TOKEN: "not-a-real-token" });

    const failure: unknown = await start.catch((error: unknown) => error);

    expect(String(failure)).toMatch(/^Error: Worker exited before it was ready:[\s\S]*TELEGRAM_BOT_TOKEN/);
    expect(String(failure)).not.toContain("not-a-real-token");
  }, bootBudget);

  it("doesn't re-run applied migrations when it starts again", async () => {
    const before = await databaseState(postgres.url);
    expect(before.applied.length).toBeGreaterThan(0);

    const worker = await startWorker(postgres.url);
    expect(await databaseState(postgres.url)).toEqual(before);
    expect(await worker.stop()).toBe(0);
  }, bootBudget);

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
      expect(polled?.nextPollAt?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      await closeDb(db);
      server.close();
    }
  }, bootBudget);

  describe("processing captured Items", () => {
    let db: Db;
    let boss: PgBoss;

    beforeAll(async () => {
      await migrate(postgres.url);
      db = createDb(postgres.url);
      // Only queues jobs. The worker under test is the one that runs and expires them.
      boss = new PgBoss({ connectionString: postgres.url, supervise: false, schedule: false });
      await boss.start();
      return async () => {
        await boss.stop();
        await closeDb(db);
      };
    });

    /** A feed with one entry, dated now so the Backfill takes it. */
    const feed = () =>
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Feed</title>` +
      `<item><guid>one</guid><title>One</title><description>An entry.</description>` +
      `<pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;

    /** A new Workspace whose saved Classifier matches the feed's entry, and a Source in it. */
    async function newSource(url: string, nextPollAt?: Date) {
      const id = crypto.randomUUID();
      await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
      const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: id }).returning();
      const workspaceId = ws?.id ?? "";
      await db.insert(classifier).values({
        workspaceId,
        name: "ones",
        kind: "deterministic",
        definition: {
          classifier: "ones",
          when: { field: "title", op: "is", value: "One" },
          assign: ["one"],
        },
      });
      const [src] = await db
        .insert(source)
        .values({
          workspaceId,
          type: "rss",
          name: "Feed",
          config: { url },
          schedule: "*/15 * * * *",
          nextPollAt,
        })
        .returning();
      return src?.id ?? "";
    }

    const itemOf = async (sourceId: string) =>
      (await db.select({ id: item.id }).from(item).where(eq(item.sourceId, sourceId)))[0]?.id;

    /** Captures one Item a saved Classifier matches, the way a poll does, with no worker running. */
    async function captureItem() {
      // Not due, so only this test captures from it, not the worker's own tick.
      const sourceId = await newSource(
        "https://feeds.test/feed.rss",
        new Date(Date.now() + 60 * 60 * 1000),
      );
      await pollSource(db, sourceId, {
        fetch: () => Promise.resolve(new Response(feed())),
        enqueueItems: itemEnqueuer(boss),
        secrets: { encryptionKey: Buffer.alloc(32), authSecret: "unused-by-rss-sources" },
      });
      const captured = await itemOf(sourceId);
      if (captured === undefined) throw new Error("Nothing was captured");
      return captured;
    }

    const jobState = async (itemId: string) =>
      (
        await db.$client.query<{ state: string }>(
          "select state from pgboss.job where name = $1 and data->>'itemId' = $2",
          [processItemQueue, itemId],
        )
      ).rows.map((row) => row.state);

    const processedAt = async (itemId: string) =>
      (await db.query.item.findFirst({ where: eq(item.id, itemId) }))?.processedAt;

    const expectClassifiedSoon = async (itemId: string) => {
      await vi.waitFor(async () => { expect(await processedAt(itemId)).not.toBeNull(); }, {
        timeout: 90_000,
        interval: 250,
      });
      expect(await db.select().from(itemCategory).where(eq(itemCategory.itemId, itemId))).toMatchObject(
        [{ category: "one" }],
      );
    };

    it("classifies an Item it captured from its own poll", async () => {
      const server = createServer((_request, response) => {
        response.setHeader("content-type", "application/rss+xml");
        response.end(feed());
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("The server has no port");
      const sourceId = await newSource(`http://127.0.0.1:${String(address.port)}/feed.rss`);

      const worker = await startWorker(postgres.url);
      try {
        const itemId = await vi.waitFor(
          async () => {
            const captured = await itemOf(sourceId);
            if (captured === undefined) throw new Error("Nothing captured yet");
            return captured;
          },
          { timeout: 30_000, interval: 100 },
        );
        await expectClassifiedSoon(itemId);
        expect(await db.select().from(itemLog).where(eq(itemLog.itemId, itemId))).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ stage: "classify", message: "Classifier ones assigned one" }),
          ]),
        );
        expect(await worker.stop()).toBe(0);
      } finally {
        server.close();
      }
    }, 120_000);

    it("processes a queued Item after a kill and a restart", async () => {
      // A first run creates the queue and is killed, so the job waits with no worker to take it.
      await (await startWorker(postgres.url)).kill();
      const itemId = await captureItem();
      expect(await jobState(itemId)).toEqual(["created"]);
      expect(await processedAt(itemId)).toBeNull();

      const restarted = await startWorker(postgres.url);
      await expectClassifiedSoon(itemId);
      expect(await restarted.stop()).toBe(0);
    }, 120_000);

    it("retries an Item whose job was running when the worker was killed", async () => {
      await (await startWorker(postgres.url)).kill();
      const itemId = await captureItem();

      // Holding the Item's row lock keeps processItem from finishing, so the kill lands mid-job.
      const lock = await db.$client.connect();
      try {
        await lock.query("begin");
        await lock.query("select 1 from item where id = $1 for update", [itemId]);
        const worker = await startWorker(postgres.url);
        await vi.waitFor(async () => { expect(await jobState(itemId)).toEqual(["active"]); }, {
          timeout: 30_000,
          interval: 100,
        });
        await worker.kill();
      } finally {
        await lock.query("rollback");
        lock.release();
      }
      expect(await jobState(itemId)).toEqual(["active"]);
      expect(await processedAt(itemId)).toBeNull();

      // Stands in for waiting out the queue's expiry and retry delay, which take minutes, and for the
      // worker's own supervisor, which runs a minute after it starts and would still do this.
      await db.$client.query(
        `update pgboss.job set started_on = now() - interval '1 hour', retry_delay = 0,
         retry_backoff = false where name = $1 and data->>'itemId' = $2`,
        [processItemQueue, itemId],
      );
      await boss.supervise(processItemQueue);

      const restarted = await startWorker(postgres.url);
      await expectClassifiedSoon(itemId);
      expect(await restarted.stop()).toBe(0);
    }, 150_000);

    /**
     * An OpenAI-compatible model on loopback, which the spawned worker reaches through its egress guard. Its
     * first request waits until the test releases it, and every other one answers at once.
     */
    async function holdingModel() {
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => (release = resolve));
      let requests = 0;
      const server = createServer((request, response) => {
        void (async () => {
          requests += 1;
          const first = requests === 1;
          const body = await text(request);
          if (first) await released;
          // The classify call's schema names its one property; the extract-and-rate call's doesn't.
          const answer = body.includes(String.raw`\"categories\"`)
            ? { categories: ["lead"] }
            : { summary: "A summary.", reasoning: "Fine.", severity: 1, importance: 2 };
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              id: "fake",
              object: "chat.completion",
              created: 0,
              model: "fake-model",
              choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(answer) }, finish_reason: "stop" }],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            }),
          );
        })().catch((error: unknown) => {
          // Answered, so a failure here shows in the Item's Log instead of a call waiting out its timeout.
          response.statusCode = 500;
          response.end(String(error));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("The model has no port");
      return {
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        requests: () => requests,
        release,
        // The worker's fetch keeps its connection alive, which would hold close() open.
        close: async () => {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => { resolve(); }));
        },
      };
    }

    it("meters a call that answers after SIGTERM, and processes its Item once restarted", async () => {
      const model = await holdingModel();
      try {
        await (await startWorker(postgres.url)).kill();
        // A Workspace with a model and an Agent-backed Classifier, so the Item's job makes a call.
        const id = crypto.randomUUID();
        await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
        const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: id }).returning();
        const workspaceId = ws?.id ?? "";
        await db
          .insert(modelConfig)
          .values({ workspaceId, providerType: "openai-compatible", baseUrl: model.baseUrl, modelName: "fake-model" });
        await db.insert(classifier).values({
          workspaceId,
          name: "leads",
          kind: "agent",
          definition: { classifier: "leads", prompt: "Find leads", categories: ["lead"] },
        });
        const [src] = await db
          .insert(source)
          .values({
            workspaceId,
            type: "rss",
            name: "Feed",
            config: { url: "https://feeds.test/agent.rss" },
            schedule: "*/15 * * * *",
            nextPollAt: new Date(Date.now() + 60 * 60 * 1000),
          })
          .returning();
        await pollSource(db, src?.id ?? "", {
          fetch: () => Promise.resolve(new Response(feed())),
          enqueueItems: itemEnqueuer(boss),
          secrets: { encryptionKey: Buffer.alloc(32), authSecret: "unused-by-rss-sources" },
        });
        const itemId = (await itemOf(src?.id ?? "")) ?? "";
        const job = async () =>
          (
            await db.$client.query<{ id: string; state: string; retry_count: number }>(
              "select id, state, retry_count from pgboss.job where name = $1 and data->>'itemId' = $2",
              [agentItemQueue, itemId],
            )
          ).rows;

        const worker = await startWorker(postgres.url);
        await vi.waitFor(() => { expect(model.requests()).toBe(1); }, { timeout: 30_000, interval: 100 });
        const exited = worker.stop();
        // pg-boss waits 30 s for the job and then fails it. The model answers only after that.
        await vi.waitFor(() => { expect(worker.output()).toContain("pg-boss stopped"); }, {
          timeout: 60_000,
          interval: 250,
        });
        model.release();
        expect(await exited).toBe(0);

        const calls = await db.select().from(agentCall).where(eq(agentCall.itemId, itemId));
        expect(calls).toEqual(
          expect.arrayContaining([expect.objectContaining({ purpose: "classify", attempt: 1, status: "ok" })]),
        );
        // The stop failed the job for a retry. pg-boss counts the retry when it starts the job again.
        expect(await job()).toMatchObject([{ state: "retry", retry_count: 0 }]);

        // Stands in for waiting out the retry's backoff.
        await db.$client.query("update pgboss.job set start_after = now() where id = $1", [(await job())[0]?.id]);
        const restarted = await startWorker(postgres.url);
        await vi.waitFor(async () => { expect(await job()).toMatchObject([{ state: "completed", retry_count: 1 }]); }, {
          timeout: 90_000,
          interval: 250,
        });
        expect(await processedAt(itemId)).not.toBeNull();
        expect(await db.select().from(itemCategory).where(eq(itemCategory.itemId, itemId))).toMatchObject([
          { category: "lead" },
        ]);
        expect(await restarted.stop()).toBe(0);
      } finally {
        await model.close();
      }
    }, bootBudget + 120_000);

    /** A Delivery of a captured Item to a new Destination of that type, with its job queued. */
    async function queueDelivery(type: "email" | "telegram") {
      const itemId = await captureItem();
      const found = await db.query.item.findFirst({ where: eq(item.id, itemId) });
      const [target] = await db
        .insert(destination)
        .values({
          workspaceId: found?.workspaceId ?? "",
          type,
          name: "me",
          config: type === "email" ? { address: "me@example.com" } : {},
          confirmedAt: new Date(),
        })
        .returning();
      const destinationId = target?.id ?? "";
      const [saved] = await db
        .insert(action)
        .values({
          workspaceId: found?.workspaceId ?? "",
          name: "ones",
          kind: "alert",
          definition: {
            action: "ones",
            when: { field: "title", op: "is", value: "One" },
            kind: "alert",
            destinations: [destinationId],
          },
        })
        .returning();
      const [row] = await db
        .insert(delivery)
        .values({ actionId: saved?.id ?? "", itemId, destinationId })
        .returning();
      const deliveryId = row?.id ?? "";
      await db.transaction((tx) => deliveryEnqueuer(boss)(tx, [deliveryId]));
      return { itemId, deliveryId };
    }

    it("starts without a Telegram bot, and a Telegram Delivery's Log says the bot isn't set up", async () => {
      await (await startWorker(postgres.url)).kill();
      const { itemId } = await queueDelivery("telegram");

      const worker = await startWorker(postgres.url);
      await vi.waitFor(
        async () => {
          const rows = await db.select().from(itemLog).where(eq(itemLog.itemId, itemId));
          expect(rows.map((row) => row.message)).toEqual(
            expect.arrayContaining([expect.stringMatching(/^Sending to me failed: the Telegram bot isn't set up/)]),
          );
        },
        { timeout: 90_000, interval: 250 },
      );
      expect(await worker.stop()).toBe(0);
    }, 150_000);

    it("runs a Delivery's job again when the worker was killed during the send", async () => {
      // A first run creates the queue and is killed, so the job waits with no worker to take it.
      await (await startWorker(postgres.url)).kill();
      const { deliveryId } = await queueDelivery("email");
      const deliveryJob = async () =>
        (
          await db.$client.query<{ state: string }>(
            "select state from pgboss.job where name = $1 and data->>'deliveryId' = $2",
            [deliverQueue, deliveryId],
          )
        ).rows.map((job) => job.state);

      // Holding the row's lock keeps the attempt from being recorded, so the kill lands mid-job.
      const lock = await db.$client.connect();
      try {
        await lock.query("begin");
        await lock.query("select 1 from delivery where id = $1 for update", [deliveryId]);
        const worker = await startWorker(postgres.url);
        await vi.waitFor(async () => { expect(await deliveryJob()).toEqual(["active"]); }, {
          timeout: 30_000,
          interval: 100,
        });
        await worker.kill();
      } finally {
        await lock.query("rollback");
        lock.release();
      }
      expect(await deliveryJob()).toEqual(["active"]);

      // Stands in for waiting out the expiry and retry delay, as in the test above.
      await db.$client.query(
        `update pgboss.job set started_on = now() - interval '1 hour', retry_delay = 0,
         retry_backoff = false where name = $1 and data->>'deliveryId' = $2`,
        [deliverQueue, deliveryId],
      );
      await boss.supervise(deliverQueue);

      const restarted = await startWorker(postgres.url);
      // Without SMTP the Mailer prints the mail, which is how a self-hosted alert still shows up somewhere.
      await vi.waitFor(
        async () => {
          const attempted = await db.query.delivery.findFirst({ where: eq(delivery.id, deliveryId) });
          expect(attempted).toMatchObject({ status: "sent", attempts: 1 });
        },
        { timeout: 90_000, interval: 250 },
      );
      expect(await restarted.stop()).toBe(0);
    }, 150_000);
  });
});
