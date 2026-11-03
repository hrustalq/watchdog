import type { MailMessage } from "@watchdog/core";
import { createDb, eq, migrate, user, verification, workspace, type Db } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";
import { pressSignIn } from "./testing.ts";
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
      // Hosted mode signs up anyone; the self-hosted sign-up gate is covered in instance.int.test.ts.
      mode: "hosted",
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

  /** Asks for a magic link, as the sign-in action does, with the page to return to. */
  async function requestLink(email: string, callbackURL = "/") {
    const request = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ email, callbackURL }),
      }),
    );
    expect(request.status).toBe(200);
    expect(mails.at(-1)?.to).toBe(email);
  }

  /** Asks for a magic link, presses the confirm page's button, and returns the session cookie. */
  async function signIn(email: string) {
    await requestLink(email);
    expect(emailedLink()).toMatch(new RegExp(`^${baseURL}/sign-in/confirm\\?token=[^&\\s]+$`));
    const verified = await pressSignIn(auth, emailedLink());
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(`${baseURL}/`);
    return verified.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
  }

  const tokenOf = (link: string) => new URL(link).searchParams.get("token") ?? "";

  const emailedLink = () => /https?:\/\/\S+/.exec(mails.at(-1)?.text ?? "")?.[0] ?? "";

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
      where: (table) => eq(table.ownerUserId, first.user.id),
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

  it("keeps the token when the emailed link is fetched before the button is pressed", async () => {
    await requestLink("grace@example.com");
    const link = emailedLink();

    // A mail scanner fetching the link, twice. It's a page of the app, which Better Auth doesn't serve.
    expect((await auth.handler(new Request(link))).status).toBe(404);
    expect((await auth.handler(new Request(link))).status).toBe(404);

    const verified = await pressSignIn(auth, link);
    expect(verified.headers.get("location")).toBe(`${baseURL}/`);
    expect(verified.headers.getSetCookie().join()).toContain("session_token=");
  });

  it("sends a used link back to sign-in with INVALID_TOKEN", async () => {
    await requestLink("heidi@example.com");
    const link = emailedLink();
    await pressSignIn(auth, link);

    const again = await pressSignIn(auth, link);

    expect(again.status).toBe(302);
    expect(again.headers.get("location")).toBe(`${baseURL}/sign-in?error=INVALID_TOKEN`);
  });

  it("sends an expired link back to sign-in with an error the sign-in page explains", async () => {
    await requestLink("ivan@example.com");
    const link = emailedLink();
    const pending = await db.query.verification.findFirst({ orderBy: (table, { desc }) => desc(table.createdAt) });
    await db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verification.id, pending?.id ?? ""));

    const expired = await pressSignIn(auth, link);

    expect(expired.status).toBe(302);
    // Better Auth's lookup skips expired rows, so an expired link reads as an unknown one.
    expect(expired.headers.get("location")).toBe(`${baseURL}/sign-in?error=INVALID_TOKEN`);
  });

  it("returns to the page sign-in was opened from", async () => {
    await requestLink("judy@example.com", "/some/page?x=1");
    expect(emailedLink()).toBe(`${baseURL}/sign-in/confirm?${new URLSearchParams({ token: tokenOf(emailedLink()), next: "/some/page?x=1" })}`);

    const verified = await pressSignIn(auth, emailedLink());

    expect(verified.headers.get("location")).toBe(`${baseURL}/some/page?x=1`);
  });

  it("keeps the page to return to when the link has stopped working", async () => {
    await requestLink("kim@example.com", "/some/page?x=1");
    await pressSignIn(auth, emailedLink());

    const again = await pressSignIn(auth, emailedLink());

    expect(again.headers.get("location")).toBe(`${baseURL}/sign-in?next=%2Fsome%2Fpage%3Fx%3D1&error=INVALID_TOKEN`);
  });

  it.each(["//evil.example", "https://evil.example", "/\\evil.example"])(
    "returns to / instead of %s from a link that names it",
    async (next) => {
      await requestLink("leo@example.com");
      const forged = new URL(emailedLink());
      forged.searchParams.set("next", next);

      const verified = await pressSignIn(auth, forged.toString());

      expect(verified.headers.get("location")).toBe(`${baseURL}/`);
    },
  );

  it("stores only a hash of the magic link's token", async () => {
    await requestLink("frank@example.com");
    const token = new URL(emailedLink()).searchParams.get("token");
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
