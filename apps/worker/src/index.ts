import { rmSync, writeFileSync } from "node:fs";
import { createAgentFetch, createEgressFetch, loadConfig } from "@watchdog/core";
import { createDb, migrate } from "@watchdog/db";
import { PgBoss } from "pg-boss";
import { itemEnqueuer, startPipeline } from "./pipeline.ts";
import { readyFile } from "./ready.ts";
import { startScheduler } from "./scheduler.ts";

// Stops with the invalid variables named before the worker does anything else.
const config = (() => {
  try {
    return loadConfig();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return process.exit(1);
  }
})();

// A restarted container keeps its filesystem, so a file from the last run must not count.
rmSync(readyFile, { force: true });

// migrate() takes no lock. Compose runs one worker, the only process that migrates, and web waits
// for it. A failure exits non-zero and Compose restarts the worker.
await migrate(config.databaseUrl);
console.log("Migrations applied");

// start() creates or upgrades the pgboss schema on first run.
const boss = new PgBoss(config.databaseUrl);
boss.on("error", (error) => {
  console.error("pg-boss error:", error);
});
await boss.start();
const db = createDb(config.databaseUrl);
await startPipeline(db, boss, {
  fetch: createAgentFetch(config),
  encryptionKey: config.encryptionKey,
});
await startScheduler(db, boss, config.mode, {
  fetch: createEgressFetch(config),
  enqueueItems: itemEnqueuer(boss),
});

// The first SIGTERM or SIGINT stops pg-boss, which stops the tick and lets running polls finish.
// A second signal while it stops is ignored.
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  rmSync(readyFile, { force: true });
  try {
    await boss.stop();
    await db.$client.end();
    console.log("Worker stopped: pg-boss stopped cleanly");
  } catch (error) {
    console.error("Worker stopped: pg-boss failed to stop:", error);
    process.exitCode = 1;
  }
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

writeFileSync(readyFile, "");
console.log(`Worker ready (${config.mode}): pg-boss started`);
