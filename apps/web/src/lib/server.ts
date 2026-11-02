import { createMailer, loadConfig } from "@watchdog/core";
import { createDb } from "@watchdog/db";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createAuth } from "./auth.ts";
import { workspaceFor } from "./workspace.ts";

function start() {
  const config = loadConfig();
  const db = createDb(config.databaseUrl);
  const auth = createAuth({
    baseURL: config.auth.url,
    secret: config.auth.secret,
    db,
    mailer: createMailer(config),
  });
  // On a self-hosted install without SMTP, magic links go to the web log instead.
  return { db, auth, baseURL: config.auth.url, mailGoesToLog: config.smtp === undefined };
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

/** The signed-in user and their Workspace. Without a valid session it redirects to sign-in. */
export async function requireWorkspace() {
  const requestHeaders = await headers();
  const { auth, db } = server();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (session === null) redirect("/sign-in");
  return { user: session.user, workspace: await workspaceFor(db, session.user) };
}
