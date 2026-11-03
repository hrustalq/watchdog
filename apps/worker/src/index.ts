import { rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "@watchdog/core";
import { migrate } from "@watchdog/db";
import { PgBoss } from "pg-boss";
import { readyFile } from "./ready.ts";

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

// The worker is the only process that migrates, and web waits for it, so they never run twice
// at once. A failure exits non-zero and Compose restarts the worker.
await migrate(config.databaseUrl);
console.log("Migrations applied");

// start() creates or upgrades the pgboss schema on first run.
const boss = new PgBoss(config.databaseUrl);
boss.on("error", (error) => {
  console.error("pg-boss error:", error);
});
await boss.start();

const stop = async () => {
  rmSync(readyFile, { force: true });
  await boss.stop();
  console.log("Worker stopped: pg-boss stopped cleanly");
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());

writeFileSync(readyFile, "");
console.log(`Worker ready (${config.mode}): pg-boss started`);
