import { botUsername, createAgentFetch, createEgressFetch, createMailer, egressPolicy, loadConfig } from "@watchdog/core";
import { createDb } from "@watchdog/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAuth, enabledProviders } from "./auth.ts";
import { isInstanceAdmin } from "./instance.ts";
import { pathHeader, returnTo, signInPath } from "./return-to.ts";
import { workspaceFor } from "./workspace.ts";

function start() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const mailer = createMailer(config);
  const auth = createAuth({
    mode: config.mode,
    baseURL: config.auth.url,
    secret: config.auth.secret,
    db,
    mailer,
    oauth: config.oauth,
  });
  const fetch = createEgressFetch(config);
  let botName: string | undefined;
  return {
    db,
    auth,
    mode: config.mode,
    /** The egress guard's fetch, for checking a feed URL before its Source is saved. */
    fetch,
    /** The egress guard's fetch for testing a model, with the time a local model can need. */
    agentFetch: createAgentFetch(config),
    /** Encrypts a model's API key. It never leaves the server. */
    encryptionKey: config.encryptionKey,
    baseURL: config.auth.url,
    // On a self-hosted install without SMTP, magic links go to the web log instead.
    mailGoesToLog: config.smtp === undefined,
    /** What the Destinations screen saves and mails with. */
    destinationDeps: {
      mailer,
      alertFrom: config.smtp?.alertFrom,
      baseURL: config.auth.url,
      encryptionKey: config.encryptionKey,
      egressAllows: egressPolicy(config),
    },
    telegramAvailable: config.telegram.botToken !== undefined,
    /**
     * The bot's username for a deep link, read once. The worker's runner is another process, and this is a
     * name Telegram gives only to whoever holds the token. Undefined until Telegram answers, so a page can say so.
     */
    telegramBotName: async () => {
      if (botName === undefined && config.telegram.botToken !== undefined) {
        botName = await botUsername(config.telegram.botToken, fetch, AbortSignal.timeout(5_000)).catch((error: unknown) => {
          process.stderr.write(`Reading the Telegram bot's name failed: ${error instanceof Error ? error.message : String(error)}\n`);
          return undefined;
        });
      }
      return botName;
    },
    /** The OAuth providers the sign-in page offers. Names only: secrets never leave the server. */
    providers: enabledProviders(config.oauth),
  };
}

let started: ReturnType<typeof start> | undefined;

/**
 * This process's database and Better Auth, set up on first use rather than on import, so that
 * `next build` runs without the runtime environment. Call it only while handling a request.
 */
export function server() {
  started ??= start();
  return started;
}

/**
 * The signed-in user, their Workspace, and whether they're the admin of this self-hosted install.
 * Without a valid session it redirects to sign-in, which returns to this page.
 */
export async function requireWorkspace() {
  const requestHeaders = await headers();
  const { auth, db, mode } = server();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (session === null) redirect(signInPath(returnTo(requestHeaders.get(pathHeader))));
  const [workspace, admin] = await Promise.all([
    workspaceFor(db, session.user),
    mode === "self-hosted" && isInstanceAdmin(db, session.user),
  ]);
  return { user: session.user, workspace, admin };
}
