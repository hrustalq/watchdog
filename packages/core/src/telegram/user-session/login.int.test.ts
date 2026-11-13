import { randomBytes } from "node:crypto";
import { tl } from "@mtcute/node";
import { NodeCryptoProvider } from "@mtcute/node/utils.js";
import { createStub, StubTelegramClient } from "@mtcute/test";
import { closeDb, createDb, type Db, eq, migrate, source, telegramLogin, telegramSession, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../../secrets/secrets.ts";
import { revokedError, revokeSession, runLogin, type SessionDeps } from "./login.ts";
import {
  answerLogin,
  cancelLogin,
  loginExpired,
  loginLost,
  loginState,
  requestRevoke,
  sessionOf,
  startLogin,
} from "./session.ts";

const encryptionKey = randomBytes(32);
const phone = "+15550001234";
const phoneCodeHash = "the-code-hash";

const account = createStub("user", { id: 42, firstName: "Ada", lastName: "Lovelace", username: "ada", self: true });
const authorized = () => createStub("auth.authorization", { user: account });
const rpcError = (text: string) => new tl.RpcError(400, text);

describe("a Telegram user session", () => {
  let db: Db;
  let workspaceId = "";
  let telegram: StubTelegramClient;
  let calls: string[];
  let jobs: string[];
  let stopping: AbortController;

  const deps = (): SessionDeps => ({ encryptionKey, createClient: () => telegram, tickMs: 5 });
  const enqueue = (_tx: unknown, id: string) => {
    jobs.push(id);
    return Promise.resolve();
  };

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
    const [saved] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: "owner" }).returning();
    workspaceId = saved?.id ?? "";
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  beforeEach(async () => {
    await db.delete(telegramLogin);
    await db.delete(telegramSession);
    await db.delete(source);
    jobs = [];
    calls = [];
    stopping = new AbortController();
    // Node's crypto, because the stub's default is the browser's, which loads its WebAssembly through fetch.
    telegram = new StubTelegramClient({ crypto: new NodeCryptoProvider() });
    telegram.respondWith("auth.sendCode", (request) => {
      calls.push(`sendCode ${request.phoneNumber}`);
      return createStub("auth.sentCode", { type: createStub("auth.sentCodeTypeApp", { length: 5 }), phoneCodeHash });
    });
  });

  afterEach(() => {
    stopping.abort();
    vi.restoreAllMocks();
  });

  /** Starts a login as the web does, and runs its job as the worker does, until it ends. */
  async function login() {
    expect(await startLogin(db, workspaceId, "+1 (555) 000-1234", enqueue)).toBe("started");
    const [loginId] = jobs;
    if (loginId === undefined) throw new Error("No job was queued");
    const job = runLogin(db, deps(), loginId, stopping.signal);
    return { loginId, job };
  }

  const until = async (step: string) =>
    vi.waitFor(
      async () => {
        const state = await loginState(db, workspaceId);
        if (state?.step !== step) throw new Error(`still ${String(state?.step)}`);
        return state;
      },
      { timeout: 5_000, interval: 10 },
    );

  const rowOf = async (id: string) => (await db.select().from(telegramLogin).where(eq(telegramLogin.id, id)))[0];
  const storedSession = async () => (await db.select().from(telegramSession).where(eq(telegramSession.workspaceId, workspaceId)))[0];

  it("signs in with the phone number and the code, and stores the session encrypted", async () => {
    telegram.respondWith("auth.signIn", (request) => {
      calls.push(`signIn ${request.phoneCodeHash} ${String(request.phoneCode)}`);
      return authorized();
    });
    const { job } = await login();

    expect(await until("code")).toEqual({ step: "code", phone, refusal: null });
    expect(await answerLogin(db, encryptionKey, workspaceId, "code", " 12345 ")).toBe(true);
    await job;

    expect(calls).toEqual([`sendCode ${phone.slice(1)}`, `signIn ${phoneCodeHash} 12345`]);
    const session = await storedSession();
    expect(session?.account).toBe("Ada Lovelace (@ada)");
    expect(decryptSecret(session?.secretCiphertext ?? "", encryptionKey)).toBe(await telegram.exportSession());
    // The login ends with it, and the screen reads only the name.
    expect(await loginState(db, workspaceId)).toBeUndefined();
    expect(await sessionOf(db, workspaceId)).toMatchObject({ account: "Ada Lovelace (@ada)", revokedAt: null });
  });

  it("asks for the 2FA password when the account has one, and says when a code or password is wrong", async () => {
    telegram.respondWith("auth.signIn", (request) => {
      if (request.phoneCode !== "12345") throw rpcError("PHONE_CODE_INVALID");
      throw new tl.RpcError(401, "SESSION_PASSWORD_NEEDED");
    });
    telegram.respondWith("account.getPassword", () => createStub("account.password"));
    // The SRP proof is real cryptography over the password Telegram describes. The stub checks the password itself.
    vi.spyOn(telegram, "computeSrpParams").mockImplementation((_request: unknown, password: string) =>
      Promise.resolve(createStub("inputCheckPasswordSRP", { A: new TextEncoder().encode(password) })),
    );
    telegram.respondWith("auth.checkPassword", (request) => {
      if (request.password._ !== "inputCheckPasswordSRP") throw rpcError("SRP_ID_INVALID");
      if (new TextDecoder().decode(request.password.A) !== " hunter2 ") throw rpcError("PASSWORD_HASH_INVALID");
      return authorized();
    });
    const { loginId, job } = await login();

    await until("code");
    await answerLogin(db, encryptionKey, workspaceId, "code", "11111");
    expect(await until("code").then(async () => vi.waitFor(async () => {
      const state = await loginState(db, workspaceId);
      if (state?.refusal === null) throw new Error("no refusal yet");
      return state;
    }))).toMatchObject({ step: "code", refusal: "That code is wrong. Check it in Telegram and enter it again." });

    // A password before Telegram asked for one is a form from another step.
    expect(await answerLogin(db, encryptionKey, workspaceId, "password", "hunter2")).toBe(false);
    await answerLogin(db, encryptionKey, workspaceId, "code", "12345");
    expect(await until("password")).toEqual({ step: "password", phone, refusal: null });
    // Used and cleared, never kept.
    expect(await rowOf(loginId)).toMatchObject({ codeCiphertext: null, passwordCiphertext: null });

    await answerLogin(db, encryptionKey, workspaceId, "password", "letmein");
    await vi.waitFor(async () => {
      if ((await loginState(db, workspaceId))?.refusal !== "That password is wrong. Enter it again.") throw new Error("not yet");
    });
    // A password is used as typed, spaces and all.
    await answerLogin(db, encryptionKey, workspaceId, "password", " hunter2 ");
    await job;

    expect((await storedSession())?.account).toBe("Ada Lovelace (@ada)");
  });

  it("keeps the code and password encrypted on the row until the worker uses them", async () => {
    await startLogin(db, workspaceId, phone, enqueue);
    await db.update(telegramLogin).set({ step: "code" });
    await answerLogin(db, encryptionKey, workspaceId, "code", "12345");
    const [row] = await db.select().from(telegramLogin);
    expect(row?.codeCiphertext).not.toContain("12345");
    expect(decryptSecret(row?.codeCiphertext ?? "", encryptionKey)).toBe("12345");
  });

  it("ends a login left at the code step after its 5 minutes, and a new one can start", async () => {
    const { loginId, job } = await login();
    await until("code");
    await db.update(telegramLogin).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await loginState(db, workspaceId)).toMatchObject({ step: "failed", refusal: loginExpired });
    await job;

    expect(await rowOf(loginId)).toBeUndefined();
    jobs = [];
    expect(await startLogin(db, workspaceId, phone, enqueue)).toBe("started");
    expect(await loginState(db, workspaceId)).toMatchObject({ step: "starting" });
  });

  it("says to start over when the worker holding the login stops", async () => {
    const { job } = await login();
    await until("code");
    stopping.abort();
    await job;
    await db.update(telegramLogin).set({ heartbeatAt: new Date(Date.now() - 11_000) });

    expect(await loginState(db, workspaceId)).toEqual({ step: "failed", phone, refusal: loginLost });
  });

  it("ends the job when the login is cancelled or replaced", async () => {
    const { job } = await login();
    await until("code");
    await cancelLogin(db, workspaceId);
    await job;
    expect(await loginState(db, workspaceId)).toBeUndefined();
  });

  it("keeps nothing from a login cancelled while Telegram signed it in, and logs that authorization out", async () => {
    const { promise: signing, resolve: signedIn } = Promise.withResolvers<undefined>();
    telegram.respondWith("auth.signIn", async () => {
      await signing;
      return authorized();
    });
    telegram.respondWith("auth.logOut", () => {
      calls.push("logOut");
      return createStub("auth.loggedOut");
    });
    await telegram.connect();
    const { job } = await login();
    await until("code");
    await answerLogin(db, encryptionKey, workspaceId, "code", "12345");
    await vi.waitFor(async () => {
      if ((await db.select().from(telegramLogin))[0]?.codeCiphertext !== null) throw new Error("not taken yet");
    });
    await cancelLogin(db, workspaceId);
    signedIn(undefined);
    await job;

    expect(await storedSession()).toBeUndefined();
    expect(calls.at(-1)).toBe("logOut");
  });

  it("keeps its heartbeat while Telegram is slow to answer", async () => {
    const { promise: answered, resolve: answer } = Promise.withResolvers<undefined>();
    let asked = false;
    telegram.respondWith("auth.sendCode", async () => {
      asked = true;
      await answered;
      return createStub("auth.sentCode", { type: createStub("auth.sentCodeTypeApp", { length: 5 }), phoneCodeHash });
    });
    const { job } = await login();
    // The job reads its row, and writes its first heartbeat, before it asks Telegram for a code.
    // Moving the heartbeat back any sooner would race that read, which would rightly end the login.
    await vi.waitFor(
      () => {
        if (!asked) throw new Error("the job hasn't asked Telegram for a code yet");
      },
      { timeout: 5_000, interval: 10 },
    );
    await db.update(telegramLogin).set({ heartbeatAt: new Date(Date.now() - 11_000) });
    await vi.waitFor(async () => {
      expect(await loginState(db, workspaceId)).toMatchObject({ step: "starting" });
    });
    answer(undefined);
    await until("code");
    stopping.abort();
    await job;
  });

  it("sends no code for a login that waited so long in the queue the screen said it ended", async () => {
    expect(await startLogin(db, workspaceId, phone, enqueue)).toBe("started");
    await db.update(telegramLogin).set({ heartbeatAt: new Date(Date.now() - 11_000) });
    await runLogin(db, deps(), jobs[0] ?? "", stopping.signal);

    expect(calls).toEqual([]);
    expect(await loginState(db, workspaceId)).toEqual({ step: "failed", phone, refusal: loginLost });
  });

  it.each([
    ["PHONE_NUMBER_INVALID", "Telegram doesn't take that phone number. Check it and start again."],
    ["API_ID_INVALID", /^Telegram refused this install's TELEGRAM_API_ID and TELEGRAM_API_HASH\./],
    ["SOMETHING_NEW", "Telegram didn't finish the login. Start again in a few minutes."],
  ])("passes Telegram's %s refusal to the screen as a fixed sentence", async (text, refusal) => {
    telegram.respondWith("auth.sendCode", () => {
      throw rpcError(text);
    });
    const { job } = await login();
    await job;

    const state = await loginState(db, workspaceId);
    expect(state).toMatchObject({ step: "failed", phone });
    expect(state?.refusal).toMatch(refusal);
  });

  it("refuses a phone number that isn't one, and a login while the Workspace has a session", async () => {
    expect(await startLogin(db, workspaceId, "call me", enqueue)).toBe("invalid-phone");
    await db.insert(telegramSession).values({ workspaceId, account: "Ada", secretCiphertext: "v1.x" });
    expect(await startLogin(db, workspaceId, phone, enqueue)).toBe("signed-in");
    expect(jobs).toEqual([]);
  });

  describe("revoking", () => {
    async function signedIn() {
      // logOut forgets the session's data centre, which a stub client only has once connected.
      await telegram.connect();
      const secretCiphertext = encryptSecret(await telegram.exportSession(), encryptionKey);
      await db.insert(telegramSession).values({ workspaceId, account: "Ada", secretCiphertext });
      const [watched] = await db
        .insert(source)
        .values({ workspaceId, type: "telegram", name: "Chat", config: { via: "session", chatId: 7, title: "Chat" }, nextPollAt: null })
        .returning();
      expect(await requestRevoke(db, workspaceId, enqueue)).toBe(true);
      const [sessionId] = jobs;
      return { sessionId: sessionId ?? "", sourceId: watched?.id ?? "" };
    }

    it("logs the session out on Telegram, deletes it, and fails its Sources", async () => {
      telegram.respondWith("auth.logOut", () => {
        calls.push("logOut");
        return createStub("auth.loggedOut");
      });
      const { sessionId, sourceId } = await signedIn();
      expect((await sessionOf(db, workspaceId))?.revokedAt).toBeInstanceOf(Date);
      // A second click while the job runs queues nothing more.
      expect(await requestRevoke(db, workspaceId, enqueue)).toBe(false);
      // One whose job ran out of retries can be asked for again.
      await db.update(telegramSession).set({ revokedAt: new Date(Date.now() - 16 * 60_000) });
      expect(await sessionOf(db, workspaceId)).toMatchObject({ revokeStuck: true });
      expect(await requestRevoke(db, workspaceId, enqueue)).toBe(true);

      await revokeSession(db, deps(), sessionId);

      expect(calls).toEqual(["logOut"]);
      expect(await sessionOf(db, workspaceId)).toBeUndefined();
      const [failing] = await db.select().from(source).where(eq(source.id, sourceId));
      expect(failing).toMatchObject({ health: "failing", lastError: revokedError });
    });

    it("deletes a session Telegram already ended, and keeps one it couldn't reach for a retry", async () => {
      telegram.respondWith("auth.logOut", () => {
        throw new tl.RpcError(503, "Timeout");
      });
      const { sessionId } = await signedIn();
      await expect(revokeSession(db, deps(), sessionId)).rejects.toThrow();
      expect(await sessionOf(db, workspaceId)).toBeDefined();

      telegram.respondWith("auth.logOut", () => {
        throw new tl.RpcError(401, "AUTH_KEY_UNREGISTERED");
      });
      await revokeSession(db, deps(), sessionId);
      expect(await sessionOf(db, workspaceId)).toBeUndefined();
    });
  });
});
