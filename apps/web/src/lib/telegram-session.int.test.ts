import { telegramLoginQueue, telegramRevokeQueue } from "@watchdog/core";
import { closeDb, createDb, type Db, migrate, source, sql, telegramLogin, telegramSession, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { PgBoss } from "pg-boss";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  answerTelegramLogin,
  cancelTelegramLogin,
  revokeTelegramSession,
  type SessionAccess,
  startTelegramLogin,
  watchTelegramChat,
} from "./telegram-session.ts";

const encryptionKey = Buffer.alloc(32, 7);

describe("the Telegram user session screen", () => {
  let db: Db;
  let boss: PgBoss;
  let workspaceId = "";
  const access = (available: boolean): SessionAccess => ({ db, available, encryptionKey, boss: () => Promise.resolve(boss), waitMs: 0 });
  const jobs = async (queue: string) =>
    (await db.execute<{ data: { id: string } }>(sql`select data from pgboss.job where name = ${queue}`)).rows.map((row) => row.data.id);

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values({ id: "us", name: "Us", email: "us@example.com" });
    const [ws] = await db.insert(workspace).values({ name: "Ours", ownerUserId: "us" }).returning();
    workspaceId = ws?.id ?? "";
    // The worker creates the queues in production; nothing works their jobs here, so a test can see them.
    boss = new PgBoss(postgres.url);
    await boss.start();
    await boss.createQueue(telegramLoginQueue);
    await boss.createQueue(telegramRevokeQueue);
    return async () => {
      await boss.stop();
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  beforeEach(async () => {
    await db.delete(telegramLogin);
    await db.delete(telegramSession);
    await db.delete(source);
    await db.execute(sql`delete from pgboss.job where name in (${telegramLoginQueue}, ${telegramRevokeQueue})`);
  });

  it("refuses every action where user sessions aren't offered, such as on hosted, and writes nothing", async () => {
    expect(await startTelegramLogin(access(false), workspaceId, "+15550001234")).toBe("unavailable");
    await db.insert(telegramLogin).values({ workspaceId, phone: "+15550001234", step: "code" });
    expect(await answerTelegramLogin(access(false), workspaceId, "code", "12345")).toBe("unavailable");
    await cancelTelegramLogin(access(false), workspaceId);
    await db.insert(telegramSession).values({ workspaceId, account: "Ada", secretCiphertext: "v1.x" });
    expect(await revokeTelegramSession(access(false), workspaceId)).toBe(false);

    const [login] = await db.select().from(telegramLogin);
    expect(login).toMatchObject({ step: "code", codeCiphertext: null });
    expect((await db.select().from(telegramSession))[0]?.revokedAt).toBeNull();
    expect([...(await jobs(telegramLoginQueue)), ...(await jobs(telegramRevokeQueue))]).toEqual([]);
  });

  it("watches a chat from the session's list as a Source, and only where user sessions are offered", async () => {
    const dialogs = [{ id: -1001234567890, title: "Ops room", type: "supergroup" as const }];
    await db.insert(telegramSession).values({ workspaceId, account: "Ada", secretCiphertext: "v1.x", dialogs });

    expect(await watchTelegramChat(access(false), workspaceId, "-1001234567890")).toBe("unavailable");
    expect(await watchTelegramChat(access(true), workspaceId, "not a chat")).toBe("not-listed");
    expect(await db.select().from(source)).toEqual([]);
    expect(await watchTelegramChat(access(true), workspaceId, "-1001234567890")).toBe("watching");
    expect(await watchTelegramChat(access(true), workspaceId, "-1001234567890")).toBe("watched");
    expect(await db.select().from(source)).toMatchObject([{ name: "Ops room", config: { via: "session", chatId: -1001234567890 } }]);
  });

  it("starts a login with its job, and revokes a session with its job, where they're offered", async () => {
    expect(await startTelegramLogin(access(true), workspaceId, "+1 555 000 1234")).toBe("started");
    const [login] = await db.select().from(telegramLogin);
    expect(login).toMatchObject({ phone: "+15550001234", step: "starting" });
    expect(await jobs(telegramLoginQueue)).toEqual([login?.id]);
    expect(await answerTelegramLogin(access(true), workspaceId, "code", "  ")).toBe("empty");
    // Not at the code step yet: the worker hasn't asked Telegram for one.
    expect(await answerTelegramLogin(access(true), workspaceId, "code", "12345")).toBe("not-asked");

    await cancelTelegramLogin(access(true), workspaceId);
    expect(await db.select().from(telegramLogin)).toEqual([]);

    const [session] = await db.insert(telegramSession).values({ workspaceId, account: "Ada", secretCiphertext: "v1.x" }).returning();
    expect(await revokeTelegramSession(access(true), workspaceId)).toBe(true);
    expect(await jobs(telegramRevokeQueue)).toEqual([session?.id]);
  });
});
