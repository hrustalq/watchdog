import { loadConfig } from "@watchdog/core";

// Next.js logs an error thrown from register and keeps serving, so a bad config exits the
// process here, before the server handles a request, with the invalid variables named.
try {
  loadConfig();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
