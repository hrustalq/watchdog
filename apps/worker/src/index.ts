import { rmSync, writeFileSync } from "node:fs";
import {
  createAgentFetch,
  createEgressFetch,
  createFloodLimiter,
  createMailer,
  createSenders,
  isUnknownLinkCodeReply,
  itemEnqueuer,
  keyFingerprint,
  linkChat,
  loadConfig,
  runBot,
  sendEmailCapNotice,
  telegramIntake,
} from "@watchdog/core";
// Apart from the main entry, which web imports too, so only the worker loads playwright-core.
import { createChromiumRenderer, createObscuraRenderer } from "@watchdog/core/render";
// Its own entry too, so only the worker loads mtcute.
import { liveSessions, revokeSession, runLogin, runSession, sessionClient } from "@watchdog/core/telegram-session";
import { createDb, instanceSettings, migrate } from "@watchdog/db";
import { PgBoss } from "pg-boss";
import { startDelivery } from "./delivery.ts";
import { startPipeline } from "./pipeline.ts";
import { readyFile } from "./ready.ts";
import { startScheduler } from "./scheduler.ts";
import { startTelegramBot } from "./telegram.ts";
import { startTelegramSessions } from "./telegram-session.ts";

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

const db = createDb(config.databaseUrl);
// Web compares this with the fingerprint of its own key, so a service recreated with a different
// WATCHDOG_ENCRYPTION_KEY shows on the Model screen at once, rather than only failing calls. It goes
// in before anything else runs, so web never starts against a stale value.
const keyPrint = keyFingerprint(config.encryptionKey);
await db
  .insert(instanceSettings)
  .values({ encryptionKeyFingerprint: keyPrint })
  .onConflictDoUpdate({ target: instanceSettings.id, set: { encryptionKeyFingerprint: keyPrint } });

// start() creates or upgrades the pgboss schema on first run.
const boss = new PgBoss(config.databaseUrl);
boss.on("error", (error) => {
  console.error("pg-boss error:", error);
});
await boss.start();
// A send holds a connection for as long as it takes, up to one a job, so slow chats can't use up the
// connections the pipeline and polls need.
const deliveryDb = createDb(config.databaseUrl);
const egressFetch = createEgressFetch(config);
const mailer = createMailer(config);
const alertFrom = config.smtp?.alertFrom;
// One limiter for the bot's messages, so the alerts and the bot runner's replies count against Telegram's
// flood limits together.
const floodLimiter = createFloodLimiter();
await startDelivery(deliveryDb, boss, {
  senders: createSenders(config, { fetch: egressFetch, mailer, telegramLimiter: floodLimiter }),
  appUrl: config.auth.url,
  secret: config.auth.secret,
  ...(config.mode === "hosted" && {
    sendCapNotice: (workspaceId: string) => sendEmailCapNotice(deliveryDb, workspaceId, mailer, alertFrom),
  }),
});
await startPipeline(
  db,
  boss,
  { fetch: createAgentFetch(config), encryptionKey: config.encryptionKey },
  // A hosted plan's node limit for an Item's JSONPath fields; a self-hosted install sets none.
  config.ruleLimits?.jsonPathNodes,
);
const { cdpUrl, cdpToken } = config.obscura;
await startScheduler(db, boss, config.mode, {
  fetch: egressFetch,
  enqueueItems: itemEnqueuer(boss),
  secrets: { encryptionKey: config.encryptionKey, authSecret: config.auth.secret },
  ...(cdpUrl !== undefined && { obscura: createObscuraRenderer({ cdpUrl, cdpToken }) }),
  ...(config.chromium && { chromium: createChromiumRenderer(config.chromium, egressFetch) }),
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
            floodLimiter,
            linkChat: (code, chat) => linkChat(db, config.encryptionKey, code, chat),
            mayDropReply: isUnknownLinkCodeReply,
            intake: telegramIntake(db, { enqueueItems: itemEnqueuer(boss) }),
            pingDatabase: () => db.$client.query("select 1"),
          },
          signal,
        ),
      );
// Hosted never has the API variables: loadConfig drops them (ADR 0014).
const { api } = config.telegram;
const sessionDeps = api && { encryptionKey: config.encryptionKey, createClient: () => sessionClient(api) };
const stopTelegramSessions =
  sessionDeps === undefined
    ? undefined
    : await startTelegramSessions(boss, {
        login: (id, signal) => runLogin(db, sessionDeps, id, signal),
        revoke: (id) => revokeSession(db, sessionDeps, id),
        session: (id, signal, until) =>
          runSession(db, { ...sessionDeps, enqueueItems: itemEnqueuer(boss) }, id, { signal, until }),
        live: () => liveSessions(db),
      });

// The first SIGTERM or SIGINT stops pg-boss, which stops the tick and lets running polls and sends finish.
// A second signal while it stops is ignored.
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  rmSync(readyFile, { force: true });
  stopTelegramBot?.();
  stopTelegramSessions?.();
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
