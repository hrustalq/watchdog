import { loadConfig, type MailMessage } from "@watchdog/core";
import { account, createDb, migrate, type Db } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAuth, enabledProviders } from "./auth.ts";
import { workspaceFor } from "./workspace.ts";

const baseURL = "http://localhost:3000";
const secret = "a-test-secret-that-is-at-least-32-characters";
const requiredEnv = { DATABASE_URL: "postgres://localhost/watchdog", BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL: baseURL };
const githubEnv = { GITHUB_CLIENT_ID: "github-client-id", GITHUB_CLIENT_SECRET: "github-client-secret" };
const googleEnv = { GOOGLE_CLIENT_ID: "google-client-id", GOOGLE_CLIENT_SECRET: "google-client-secret" };

/**
 * GitHub's side of the code exchange, answered the way GitHub's API answers it, so no request
 * leaves the test. `email` is the account's primary address and `verified` is what GitHub says.
 */
function fakeGitHub(person: { id: number; email: string; verified: boolean }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = input instanceof Request ? input.url : input.toString();
    switch (url) {
      case "https://github.com/login/oauth/access_token":
        return Promise.resolve(
          Response.json({ access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" }),
        );
      case "https://api.github.com/user":
        return Promise.resolve(
          Response.json({ id: person.id, login: "octocat", name: "The Octocat", email: null, avatar_url: null }),
        );
      case "https://api.github.com/user/emails":
        return Promise.resolve(
          Response.json([{ email: person.email, primary: true, verified: person.verified, visibility: "private" }]),
        );
      default:
        return Promise.reject(new Error(`Unexpected request to ${url}`));
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OAuth providers", () => {
  it("offers only the providers whose ID and secret are both set", () => {
    expect(enabledProviders(loadConfig(requiredEnv).oauth)).toEqual([]);
    expect(enabledProviders(loadConfig({ ...requiredEnv, ...githubEnv }).oauth)).toEqual(["github"]);
    expect(enabledProviders(loadConfig({ ...requiredEnv, ...googleEnv, ...githubEnv }).oauth)).toEqual([
      "google",
      "github",
    ]);
  });
});

describe("OAuth sign-in", () => {
  let db: Db;
  const mails: MailMessage[] = [];
  const authWith = (env: Record<string, string>) =>
    createAuth({
      baseURL,
      secret,
      db,
      mailer: {
        send: (message) => {
          mails.push(message);
          return Promise.resolve();
        },
      },
      oauth: loadConfig({ ...requiredEnv, ...env }).oauth,
    });
  let auth: ReturnType<typeof authWith>;

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    auth = authWith(githubEnv);
    return async () => {
      await db.$client.end();
      await postgres.stop();
    };
  }, 120_000);

  /** Starts a GitHub sign-in the way the sign-in page does and returns where GitHub is asked to send the user back. */
  async function startGitHub(using = auth) {
    const { headers, response } = await using.api.signInSocial({
      body: { provider: "github", callbackURL: "/", errorCallbackURL: "/sign-in?via=github" },
      headers: new Headers({ origin: baseURL }),
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((set) => set.split(";")[0])
      .join("; ");
    return { authorize: new URL(response.url ?? ""), cookie };
  }

  /** Comes back from GitHub with a code and returns the redirect Better Auth answers with. */
  async function finishGitHub(person: { id: number; email: string; verified: boolean }) {
    const { authorize, cookie } = await startGitHub();
    fakeGitHub(person);
    const state = authorize.searchParams.get("state") ?? "";
    const callback = await auth.handler(
      new Request(`${baseURL}/api/auth/callback/github?code=test-code&state=${state}`, { headers: { cookie } }),
    );
    vi.restoreAllMocks();
    expect(callback.status).toBe(302);
    return {
      location: callback.headers.get("location") ?? "",
      cookie: callback.headers
        .getSetCookie()
        .map((set) => set.split(";")[0])
        .join("; "),
    };
  }

  async function signInByMagicLink(email: string) {
    await auth.api.signInMagicLink({ body: { email, callbackURL: "/" }, headers: new Headers() });
    const link = /https?:\/\/\S+/.exec(mails.at(-1)?.text ?? "")?.[0] ?? "";
    const verified = await auth.handler(new Request(link));
    return verified.headers
      .getSetCookie()
      .map((set) => set.split(";")[0])
      .join("; ");
  }

  /** What the app does on the request that follows: read the session, then its Workspace. */
  async function openApp(cookie: string) {
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (session === null) throw new Error("No session after signing in");
    return { user: session.user, workspace: await workspaceFor(db, session.user) };
  }

  const accountsOf = (userId: string) =>
    db.query.account.findMany({ where: (table, { eq }) => eq(table.userId, userId) });

  it("sends the user to GitHub with the callback URL built on the base URL", async () => {
    const { authorize } = await startGitHub();

    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("client_id")).toBe("github-client-id");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${baseURL}/api/auth/callback/github`);
    expect(authorize.searchParams.get("scope")).toBe("read:user user:email");
  });

  it("doesn't register a provider without credentials", async () => {
    const withoutOAuth = authWith({});

    await expect(startGitHub(withoutOAuth)).rejects.toThrow("Provider not found");
    // Even a callback carrying a valid state, started where GitHub is configured, gets nowhere.
    const { authorize, cookie } = await startGitHub();
    const state = authorize.searchParams.get("state") ?? "";
    const callback = await withoutOAuth.handler(
      new Request(`${baseURL}/api/auth/callback/github?code=test-code&state=${state}`, { headers: { cookie } }),
    );
    expect(callback.headers.get("location")).toBe("/sign-in?via=github&error=oauth_provider_not_found");
  });

  it("signs up a new user with a verified GitHub email into one Workspace", async () => {
    const { location, cookie } = await finishGitHub({ id: 101, email: "Hana@Example.com", verified: true });

    expect(location).toBe("/");
    const { user: hana, workspace: hanaWorkspace } = await openApp(cookie);
    expect(hana).toMatchObject({ email: "hana@example.com", emailVerified: true });
    expect(hanaWorkspace).toMatchObject({ name: "hana", ownerUserId: hana.id });
    const again = await finishGitHub({ id: 101, email: "hana@example.com", verified: true });
    expect((await openApp(again.cookie)).workspace.id).toBe(hanaWorkspace.id);
  });

  it("reaches the same user and Workspace by magic link and then by GitHub", async () => {
    const byLink = await openApp(await signInByMagicLink("ivan@example.com"));

    const { location, cookie } = await finishGitHub({ id: 102, email: "ivan@example.com", verified: true });

    expect(location).toBe("/");
    const byGitHub = await openApp(cookie);
    expect(byGitHub.user.id).toBe(byLink.user.id);
    expect(byGitHub.workspace.id).toBe(byLink.workspace.id);
    const users = await db.query.user.findMany({ where: (table, { eq }) => eq(table.email, "ivan@example.com") });
    expect(users).toHaveLength(1);
    const owned = await db.query.workspace.findMany({ where: (table, { eq }) => eq(table.ownerUserId, byLink.user.id) });
    expect(owned).toHaveLength(1);
    expect((await accountsOf(byLink.user.id)).map((row) => row.providerId)).toContain("github");
  });

  it("doesn't let a GitHub account with an unverified email into a magic-link account", async () => {
    const { user: judy } = await openApp(await signInByMagicLink("judy@example.com"));
    const accountsBefore = await db.$count(account);

    const { location, cookie } = await finishGitHub({ id: 103, email: "judy@example.com", verified: false });

    expect(new URL(location, baseURL).searchParams.get("error")).toBe("account_not_linked");
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    expect(await db.$count(account)).toBe(accountsBefore);
    expect((await accountsOf(judy.id)).map((row) => row.providerId)).not.toContain("github");
  });

  it("doesn't create a user from a GitHub email that isn't verified", async () => {
    const { location, cookie } = await finishGitHub({ id: 104, email: "kai@example.com", verified: false });

    const back = new URL(location, baseURL);
    expect(back.pathname).toBe("/sign-in");
    expect(back.searchParams.get("via")).toBe("github");
    expect(back.searchParams.get("error")).toBe("email_not_verified");
    expect(await auth.api.getSession({ headers: new Headers({ cookie }) })).toBeNull();
    // Nothing is left on the address, so its owner's later Google or GitHub sign-in isn't blocked.
    expect(await db.query.user.findFirst({ where: (table, { eq }) => eq(table.email, "kai@example.com") })).toBeUndefined();
    const { location: owner } = await finishGitHub({ id: 204, email: "kai@example.com", verified: true });
    expect(owner).toBe("/");
  });
});
