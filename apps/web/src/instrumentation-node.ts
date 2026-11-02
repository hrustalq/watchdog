import { loadConfig } from "@watchdog/core";
import { createDb } from "@watchdog/db";
import { setupUrl } from "./lib/instance.ts";

/** Runs once before the server handles a request. */
export async function start() {
  // Next.js logs an error thrown from register and keeps serving, so a bad config exits the
  // process here, before the server handles a request, with the invalid variables named.
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }

  // A self-hosted install with no admin yet prints a fresh setup URL. Only someone who can read
  // this log can claim the install, and nobody can sign up before that. Hosted gets no URL.
  const db = createDb(config.databaseUrl);
  try {
    const url = await setupUrl(config.mode, db, config.auth.url);
    if (url !== undefined) {
      process.stdout.write(
        `Watchdog has no admin yet. Open this link to set it up and become its admin:\n\n${url}\n\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `Watchdog couldn't create its setup link, so nobody can sign up yet. Restart web once the database is reachable and migrated. ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    await db.$client.end();
  }
}
