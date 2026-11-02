import { loadConfig, type Config } from "@watchdog/core";
import { createDb } from "@watchdog/db";
import { setupUrl } from "./lib/instance.ts";

const retryMs = 5000;

/** Runs once before the server handles a request. */
export function start() {
  // Next.js logs an error thrown from register and keeps serving, so a bad config exits the
  // process here, before the server handles a request, with the invalid variables named.
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  // Not awaited: the server must come up even while the database isn't reachable yet.
  announceSetup(config);
}

/**
 * A self-hosted install with no admin yet prints a fresh setup URL. Only someone who can read this
 * log can claim the install, and nobody can sign up before that. Hosted gets no URL. Until the
 * database is reachable and migrated, it tries again every few seconds.
 */
function announceSetup(config: Config) {
  const db = createDb(config.databaseUrl);
  let warned = false;
  const attempt = async () => {
    try {
      const url = await setupUrl(config.mode, db, config.auth.url);
      if (url !== undefined) {
        process.stdout.write(
          `Watchdog has no admin yet. Open this link to set it up and become its admin:\n\n${url}\n\n`,
        );
      }
      await db.$client.end();
    } catch (error) {
      if (!warned) {
        warned = true;
        process.stderr.write(
          `Watchdog can't create its setup link yet, so nobody can sign up. It keeps trying until the database is reachable and migrated. ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      setTimeout(() => void attempt(), retryMs).unref();
    }
  };
  void attempt();
}
