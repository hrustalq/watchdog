import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

// With no mail server, a self-hosted Watchdog prints its setup link and every magic link to the
// web container's log, so the smoke test reads its links from there. The project is named outright,
// as in smoke.sh, so a run without that script can't claim the install that `docker compose up`
// started and make smoke@example.com its admin.

const run = promisify(execFile);

async function webLog() {
  const args = ["compose", "--project-name", "watchdog-smoke", "logs", "--no-log-prefix", "web"];
  const { stdout } = await run("docker", args);
  return stdout;
}

/** Reads the web log until `find` returns a link, and returns that link. */
async function linkFromWebLog(what: string, find: (log: string) => string | undefined) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const link = find(await webLog());
    if (link !== undefined) return link;
    if (Date.now() > deadline) throw new Error(`No ${what} in the web container's log after 15 seconds`);
    await setTimeout(500);
  }
}

/** The setup link the web container printed last: each start replaces the one before. */
export const setupLink = () =>
  linkFromWebLog("setup link", (log) => log.match(/^https?:\/\/\S+\/setup\?token=\S+$/gm)?.at(-1));

/** The link in the last sign-in mail printed for `email`. */
export const magicLink = (email: string) =>
  linkFromWebLog(`magic link for ${email} (with SMTP set in .env, it was mailed instead)`, (log) => {
    const mail = log.lastIndexOf(`To: ${email}\n`);
    return mail === -1 ? undefined : /https?:\/\/\S+\/sign-in\/confirm\?\S+/.exec(log.slice(mail))?.[0];
  });
