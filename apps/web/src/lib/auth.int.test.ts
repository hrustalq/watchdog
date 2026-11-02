import type { MailMessage } from "@watchdog/core";
import { createDb, migrate, user, workspace, type Db } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";
import { workspaceFor } from "./workspace.ts";

const baseURL = "http://localhost:3000";

describe("magic link sign-in", () => {
  let db: Db;
  let auth: ReturnType<typeof createAuth>;
  const mails: MailMessage[] = [];

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    auth = createAuth({
      baseURL,
      secret: "a-test-secret-that-is-at-least-32-characters",
      db,
      mailer: {
        send: (message) => {
          mails.push(message);
          return Promise.resolve();
        },
      },
    });
    return async () => {
      await db.$client.end();
      await postgres.stop();
    };
  }, 120_000);

  /** Asks for a magic link, opens it, and returns the session cookie it sets. */
  async function signIn(email: string) {
    const request = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ email, callbackURL: "/" }),
      }),
    );
    expect(request.status).toBe(200);

    const mail = mails.at(-1);
    expect(mail?.to).toBe(email);
    const link = /https?:\/\/\S+/.exec(mail?.text ?? "")?.[0];
    expect(link).toMatch(`${baseURL}/api/auth/magic-link/verify?token=`);

    const verified = await auth.handler(new Request(link ?? ""));
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(`${baseURL}/`);
    return verified.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  }

  /** What the app does on the request that follows: read the session, then its Workspace. */
  async function openApp(cookie: string) {
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (session === null) throw new Error("No session after opening the magic link");
    return { user: session.user, workspace: await workspaceFor(db, session.user) };
  }

  it("signs up a new user with exactly one Workspace that they own", async () => {
    const { user: alice, workspace: aliceWorkspace } = await openApp(await signIn("alice@example.com"));

    expect(alice.email).toBe("alice@example.com");
    expect(aliceWorkspace).toMatchObject({ name: "alice", ownerUserId: alice.id });
    expect(await db.$count(user)).toBe(1);
    expect(await db.$count(workspace)).toBe(1);
  });

  it("reuses the user and the Workspace on later sign-ins", async () => {
    const first = await openApp(await signIn("bob@example.com"));
    const second = await openApp(await signIn("bob@example.com"));
    const third = await openApp(await signIn("bob@example.com"));

    expect([second.user.id, third.user.id]).toEqual([first.user.id, first.user.id]);
    expect([second.workspace.id, third.workspace.id]).toEqual([first.workspace.id, first.workspace.id]);
    const owned = await db.query.workspace.findMany({
      where: (table, { eq }) => eq(table.ownerUserId, first.user.id),
    });
    expect(owned).toHaveLength(1);
  });

  it("creates one Workspace when the first requests race", async () => {
    const [carol] = await db
      .insert(user)
      .values({ id: "carol", name: "", email: "carol@example.com" })
      .returning();
    if (carol === undefined) throw new Error("No user inserted");

    const raced = await Promise.all([1, 2, 3].map(() => workspaceFor(db, carol)));

    expect(new Set(raced.map((created) => created.id)).size).toBe(1);
  });

  it("allows only one Workspace per user", async () => {
    const { user: dave } = await openApp(await signIn("dave@example.com"));

    await expect(db.insert(workspace).values({ name: "second", ownerUserId: dave.id })).rejects.toThrow();
  });

  it("stores only a hash of the magic link's token", async () => {
    await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ email: "frank@example.com", callbackURL: "/" }),
      }),
    );
    const token = new URL(/https?:\/\/\S+/.exec(mails.at(-1)?.text ?? "")?.[0] ?? baseURL).searchParams.get("token");
    expect(token).toBeTruthy();

    const stored = await db.query.verification.findMany();
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.flatMap((row) => [row.identifier, row.value]).join(" ")).not.toContain(token);
  });

  it("ends the session on sign-out", async () => {
    const cookie = await signIn("erin@example.com");

    const signedOut = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-out`, { method: "POST", headers: { cookie, origin: baseURL } }),
    );

    expect(signedOut.status).toBe(200);
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
  });
});
