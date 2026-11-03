import type { MailMessage } from "@watchdog/core";
import { createDb, instanceSettings, migrate, type Db } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth.ts";
import { claimInstance, isInstanceAdmin, setSignupOpen, setupUrl } from "./instance.ts";
import { pressSignIn } from "./testing.ts";

const baseURL = "http://localhost:3000";

/** A fresh database and Better Auth in the given mode, with mail captured instead of sent. */
function stack(mode: "self-hosted" | "hosted") {
  let started: { db: Db; auth: ReturnType<typeof createAuth> } | undefined;
  const ready = () => {
    if (started === undefined) throw new Error("The stack hasn't started");
    return started;
  };
  const mails: MailMessage[] = [];

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    const db = createDb(postgres.url);
    started = {
      db,
      auth: createAuth({
      mode,
      baseURL,
      secret: "a-test-secret-that-is-at-least-32-characters",
      db,
      mailer: {
        send: (message) => {
          mails.push(message);
          return Promise.resolve();
        },
      },
      }),
    };
    return async () => {
      await db.$client.end();
      await postgres.stop();
    };
  }, 120_000);

  /** Asks for a magic link and opens it. Returns where it lands and the session cookie it sets. */
  async function signIn(email: string) {
    await ready().auth.api.signInMagicLink({
      body: { email, callbackURL: "/", errorCallbackURL: "/sign-in" },
      headers: new Headers(),
    });
    const link = /https?:\/\/\S+/.exec(mails.at(-1)?.text ?? "")?.[0] ?? "";
    const verified = await pressSignIn(ready().auth, link);
    const cookie = verified.headers
      .getSetCookie()
      .map((set) => set.split(";")[0])
      .join("; ");
    const session = await ready().auth.api.getSession({ headers: new Headers({ cookie }) });
    const location = new URL(verified.headers.get("location") ?? "", baseURL);
    return { error: location.searchParams.get("error"), user: session?.user };
  }

  const userCalled = (email: string) =>
    ready().db.query.user.findFirst({ where: (table, { eq }) => eq(table.email, email) });

  return { ready, signIn, userCalled };
}

describe("a self-hosted install", () => {
  const { ready, signIn, userCalled } = stack("self-hosted");
  let token = "";

  it("refuses every sign-up until someone uses the setup URL", async () => {
    const url = await setupUrl("self-hosted", ready().db, baseURL);
    token = new URL(url ?? baseURL).searchParams.get("token") ?? "";
    expect(url).toMatch(`${baseURL}/setup?token=`);
    expect(token).not.toBe("");

    const { error, user } = await signIn("stranger@example.com");

    expect(error).toBe("setup_pending");
    expect(user).toBeUndefined();
    expect(await userCalled("stranger@example.com")).toBeUndefined();
  });

  it("stores only a hash of the setup token", async () => {
    const stored = await ready().db.query.instanceSettings.findFirst();
    expect(stored?.setupTokenHash).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("refuses a claim with a wrong token", async () => {
    expect(await claimInstance(ready().db, "not-the-token", "mallory@example.com")).toBe(false);
    expect((await signIn("mallory@example.com")).error).toBe("setup_pending");
  });

  it("makes the person who uses the setup URL the admin", async () => {
    expect(await claimInstance(ready().db, token, "Owner@Example.com")).toBe(true);

    const { error, user } = await signIn("owner@example.com");

    expect(error).toBeNull();
    if (user === undefined) throw new Error("The admin wasn't signed in");
    expect(await isInstanceAdmin(ready().db, user)).toBe(true);
    expect((await ready().db.query.instanceSettings.findFirst())?.adminUserId).toBe(user.id);
  });

  it("refuses a second claim and issues no new setup URL once an admin exists", async () => {
    expect(await claimInstance(ready().db, token, "second@example.com")).toBe(false);
    expect(await setupUrl("self-hosted", ready().db, baseURL)).toBeUndefined();
    expect((await signIn("second@example.com")).error).toBe("signup_closed");
  });

  it("keeps sign-up closed after setup until the admin opens it", async () => {
    const closed = await signIn("newcomer@example.com");
    expect(closed.error).toBe("signup_closed");
    expect(await userCalled("newcomer@example.com")).toBeUndefined();

    await setSignupOpen(ready().db, true);
    const opened = await signIn("newcomer@example.com");
    expect(opened.error).toBeNull();
    expect(opened.user?.email).toBe("newcomer@example.com");
    if (opened.user === undefined) throw new Error("The newcomer wasn't signed in");
    expect(await isInstanceAdmin(ready().db, opened.user)).toBe(false);

    await setSignupOpen(ready().db, false);
    expect((await signIn("latecomer@example.com")).error).toBe("signup_closed");
  });

  it("lets existing users sign in while sign-up is closed", async () => {
    const owner = await signIn("owner@example.com");
    const newcomer = await signIn("newcomer@example.com");

    expect([owner.error, newcomer.error]).toEqual([null, null]);
    expect(owner.user?.email).toBe("owner@example.com");
    expect(newcomer.user?.email).toBe("newcomer@example.com");
  });
});

describe("a hosted install", () => {
  const { ready, signIn } = stack("hosted");

  it("issues no setup URL and accepts any sign-up", async () => {
    expect(await setupUrl("hosted", ready().db, baseURL)).toBeUndefined();

    const { error, user } = await signIn("anyone@example.com");

    expect(error).toBeNull();
    expect(user?.email).toBe("anyone@example.com");
    expect(await ready().db.$count(instanceSettings)).toBe(0);
  });
});
