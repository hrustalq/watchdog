import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

// The Compose stack smoke.sh starts, reached from outside it. With no mail server, a self-hosted
// Watchdog prints its setup link and every mail to the log of the container that sent it: sign-in and
// confirmation links in web's, alerts in the worker's. The project is named outright, as in smoke.sh,
// so a run without that script can't claim the install that `docker compose up` started and make
// smoke@example.com its admin.

const run = promisify(execFile);

async function compose(...args: string[]) {
  // The default 1 MiB would cut off a long run's whole log.
  const options = { maxBuffer: 64 * 1024 * 1024 };
  const { stdout } = await run("docker", ["compose", "--project-name", "watchdog-smoke", ...args], options);
  return stdout;
}

const logOf = (service: "web" | "worker") => compose("logs", "--no-log-prefix", service);

/** Reads the web log until `find` returns a link, and returns that link. */
async function linkFromWebLog(what: string, find: (log: string) => string | undefined) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const link = find(await logOf("web"));
    if (link !== undefined) return link;
    if (Date.now() > deadline) throw new Error(`No ${what} in the web container's log after 15 seconds`);
    await setTimeout(500);
  }
}

/** The setup link the web container printed last: each start replaces the one before. */
export const setupLink = () =>
  linkFromWebLog("setup link", (log) => log.match(/^https?:\/\/\S+\/setup\?token=\S+$/gm)?.at(-1));

/** Every mail in `log` to `address`, oldest first. */
function mailsTo(log: string, address: string) {
  const mails = log.split("SMTP is not configured, so this mail is printed instead of sent.\n");
  return mails.filter((mail) => mail.startsWith(`To: ${address}\n`));
}

// A link works once, and Docker can take a moment to pass a new line to the log.
const returned = new Set<string>();

/** The link to `path` in the last mail web printed to `address`, once it isn't one this returned before. */
async function mailedLink(what: string, address: string, path: string) {
  const link = await linkFromWebLog(`${what} for ${address} (with SMTP set in .env, it was mailed instead)`, (log) => {
    const found = new RegExp(`https?://\\S+${path}\\?\\S+`).exec(mailsTo(log, address).at(-1) ?? "")?.[0];
    return found === undefined || returned.has(found) ? undefined : found;
  });
  returned.add(link);
  return link;
}

export const magicLink = (email: string) => mailedLink("magic link", email, "/sign-in/confirm");

export const confirmationLink = (address: string) => mailedLink("confirmation link", address, "/destinations/confirm");

/** Every mail the worker printed to `address`: alerts and Digests. */
export const workerMailsTo = async (address: string) => mailsTo(await logOf("worker"), address);

// The fake Bot API (fixtures/fake-telegram.mjs) publishes no port, so the test reaches it from inside.
const fakeTelegram = (...args: string[]) =>
  compose("exec", "-T", "fake-telegram", "wget", "-q", "-O", "-", ...args);

/** A message a person sends the bot from `chat`. */
export async function sendToBot(chat: { id: number; type: string; title?: string }, text: string) {
  await fakeTelegram("--post-data", JSON.stringify({ chat, text }), "http://127.0.0.1:8080/fake/updates");
}

/** The text of every message the bot sent, in order: alerts and the bot's own replies. */
export async function botMessages() {
  const sent: unknown = JSON.parse(await fakeTelegram("http://127.0.0.1:8080/fake/sent"));
  if (!Array.isArray(sent) || !sent.every((text): text is string => typeof text === "string")) {
    throw new Error("The fake Telegram API's record isn't a list of texts");
  }
  return sent;
}

/** Adds one of alerts.xml's later entries to the feed, from its next request on. */
export async function publishEntry(name: "first" | "second") {
  await compose("exec", "-T", "fixtures", "touch", `/srv/published/${name}`);
}

/** A feed the fixtures container serves, at the address a Source is added with. */
export const fixtureFeed = (path: string) => `http://fixtures/${path}`;

/** A page of the fixture site (fixture-site.mjs), at the address a website Source is added with. */
export const fixturePage = (path: string) => `http://fixture-site:8080/page/${path}`;

/**
 * Makes the fixture site serve its second version of every page, so the next poll of a website Source
 * finds a change. A POST from inside the containers, because the site publishes no port.
 */
export async function flipFixtureSite() {
  await compose("exec", "-T", "fixture-site", "wget", "-q", "-O", "-", "--post-data=", "http://127.0.0.1:8080/flip");
}
