import { rmSync, writeFileSync } from "node:fs";
import {
  createAgentFetch,
  createEgressFetch,
  createMailer,
  createSenders,
  linkChat,
  loadConfig,
  runBot,
  sendEmailCapNotice,
} from "@watchdog/core";
import { createDb, migrate } from "@watchdog/db";
import { PgBoss } from "pg-boss";
import { startDelivery } from "./delivery.ts";
import { itemEnqueuer, startPipeline } from "./pipeline.ts";
import { readyFile } from "./ready.ts";
import { startScheduler } from "./scheduler.ts";
import { startTelegramBot } from "./telegram.ts";

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
// A send holds a connection for as long as it takes, up to one a job, so slow chats can't use up the
// connections the pipeline and polls need.
const deliveryDb = createDb(config.databaseUrl);
const egressFetch = createEgressFetch(config);
const mailer = createMailer(config);
const alertFrom = config.smtp?.alertFrom;
await startDelivery(deliveryDb, boss, {
  senders: createSenders(config, { fetch: egressFetch, mailer }),
  appUrl: config.auth.url,
  secret: config.auth.secret,
  ...(config.mode === "hosted" && {
    sendCapNotice: (workspaceId: string) => sendEmailCapNotice(deliveryDb, workspaceId, mailer, alertFrom),
  }),
});
await startPipeline(db, boss, {
  fetch: createAgentFetch(config),
  encryptionKey: config.encryptionKey,
});
await startScheduler(db, boss, config.mode, {
  fetch: egressFetch,
  enqueueItems: itemEnqueuer(boss),
});
const { botToken } = config.telegram;
const stopTelegramBot =
  botToken === undefined
    ? undefined
    : await startTelegramBot(boss, (signal) =>
        runBot(
          {
            botToken,
            fetch: egressFetch,
            linkChat: (code, chat) => linkChat(db, config.encryptionKey, code, chat),
          },
          signal,
        ),
      );

// The first SIGTERM or SIGINT stops pg-boss, which stops the tick and lets running polls and sends finish.
// A second signal while it stops is ignored.
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  rmSync(readyFile, { force: true });
  stopTelegramBot?.();
  try {
    await boss.stop();
    await db.$client.end();
    await deliveryDb.$client.end();
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
