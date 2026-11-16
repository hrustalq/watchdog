// Prints a setup URL for a self-hosted install whose web runs somewhere that doesn't keep a process
// alive: every Vercel cold start would rotate the token printed by instrumentation, so the deploy
// runs this once instead (deploy/vercel/README.md). The worker must have applied the migrations.
import { loadConfig } from "@watchdog/core";
import { closeDb, createDb } from "@watchdog/db";
import { setupUrl } from "../src/lib/instance.ts";

const config = loadConfig();
const db = createDb(config.databaseUrl);
try {
  const url = await setupUrl(config.mode, db, config.auth.url);
  process.stdout.write(
    `${url ?? "This install already has an admin, so there is no setup link to print."}\n`,
  );
} finally {
  await closeDb(db);
}
