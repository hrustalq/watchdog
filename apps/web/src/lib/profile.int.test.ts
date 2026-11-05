import { loadProfile } from "@watchdog/core";
import { closeDb, createDb, type Db, migrate, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { maxProfileBody, outputLanguages, saveProfile, tooLongFormQuery } from "./profile.ts";

describe("the Profile screen", () => {
  let db: Db;

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  async function newWorkspace() {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    const [row] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: id }).returning();
    if (row === undefined) throw new Error("Expected a Workspace");
    return row.id;
  }

  it("reloads a saved Profile with its text and language", async () => {
    const workspaceId = await newWorkspace();

    expect(await saveProfile(db, workspaceId, { body: "I build Watchdog.", language: "de" })).toEqual({ saved: true });

    expect(await loadProfile(db, workspaceId)).toEqual({ body: "I build Watchdog.", outputLanguage: "de" });
  });

  it("applies a later save to what the next call loads", async () => {
    const workspaceId = await newWorkspace();
    await saveProfile(db, workspaceId, { body: "First", language: "de" });
    await saveProfile(db, workspaceId, { body: "Second", language: "fr" });

    expect(await loadProfile(db, workspaceId)).toEqual({ body: "Second", outputLanguage: "fr" });
  });

  it("can empty a saved Profile", async () => {
    const workspaceId = await newWorkspace();
    await saveProfile(db, workspaceId, { body: "First", language: "en" });

    expect(await saveProfile(db, workspaceId, { body: "", language: "en" })).toEqual({ saved: true });

    expect((await loadProfile(db, workspaceId)).body).toBe("");
  });

  it("refuses a body over the cap and keeps what was saved", async () => {
    const workspaceId = await newWorkspace();
    await saveProfile(db, workspaceId, { body: "Saved", language: "de" });

    const result = await saveProfile(db, workspaceId, { body: "x".repeat(maxProfileBody + 1), language: "en" });

    expect(result).toEqual({ problem: "too-long" });
    expect(await loadProfile(db, workspaceId)).toEqual({ body: "Saved", outputLanguage: "de" });
  });

  it("accepts a body exactly at the cap", async () => {
    const workspaceId = await newWorkspace();
    const body = "x".repeat(maxProfileBody);

    expect(await saveProfile(db, workspaceId, { body, language: "en" })).toEqual({ saved: true });

    expect((await loadProfile(db, workspaceId)).body).toBe(body);
  });

  // The browser counts a newline as one character, then posts it as two.
  it("counts a posted CRLF as one character, and stores it as a newline", async () => {
    const workspaceId = await newWorkspace();
    const lines = "x\r\n".repeat(maxProfileBody / 2 - 1);
    const posted = `${lines}xx`;
    expect(posted.length).toBeGreaterThan(maxProfileBody);

    expect(await saveProfile(db, workspaceId, { body: posted, language: "en" })).toEqual({ saved: true });

    const { body } = await loadProfile(db, workspaceId);
    expect(body).toHaveLength(maxProfileBody);
    expect(body).not.toContain("\r");
  });

  it("doesn't count surrounding whitespace, and doesn't keep it", async () => {
    const workspaceId = await newWorkspace();
    const body = "x".repeat(maxProfileBody);

    expect(await saveProfile(db, workspaceId, { body: `\n  ${body}  \n`, language: "en" })).toEqual({ saved: true });

    expect((await loadProfile(db, workspaceId)).body).toBe(body);
  });

  it("stores text Postgres would otherwise refuse", async () => {
    const workspaceId = await newWorkspace();

    const result = await saveProfile(db, workspaceId, { body: "nul\0 and half \ud83d a pair", language: "en" });

    expect(result).toEqual({ saved: true });
    expect((await loadProfile(db, workspaceId)).body).toBe("nul and half � a pair");
  });

  it.each(["", "EN", "english", "xx", "en-US"])("refuses the output language %j", async (language) => {
    const workspaceId = await newWorkspace();

    expect(await saveProfile(db, workspaceId, { body: "Text", language })).toEqual({ problem: "language" });

    expect(await loadProfile(db, workspaceId)).toEqual({ body: "", outputLanguage: "en" });
  });

  it("never changes or shows another Workspace's Profile", async () => {
    const owner = await newWorkspace();
    const other = await newWorkspace();
    await saveProfile(db, owner, { body: "Private", language: "fr" });

    expect(await loadProfile(db, other)).toEqual({ body: "", outputLanguage: "en" });

    await saveProfile(db, other, { body: "Mine", language: "de" });
    expect(await loadProfile(db, owner)).toEqual({ body: "Private", outputLanguage: "fr" });
  });
});

describe("outputLanguages", () => {
  it("lists every ISO 639-1 language once, by name, with en among them", () => {
    const codes = outputLanguages.map(({ code }) => code);

    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.length).toBeGreaterThan(180);
    expect(codes).toContain("en");
    expect(outputLanguages.find(({ code }) => code === "ru")?.label).toBe("Russian (ru)");
    // A code Intl has no name for would show as "xx (xx)".
    expect(outputLanguages.filter(({ code, label }) => label === `${code} (${code})`)).toEqual([]);
  });
});

describe("tooLongFormQuery", () => {
  it("sends a refused body back when it fits in a URL", () => {
    const query = tooLongFormQuery({ body: "x".repeat(maxProfileBody + 1), language: "de" });

    expect(query.get("error")).toBe("too-long");
    expect(query.get("language")).toBe("de");
    expect(query.get("body")).toHaveLength(maxProfileBody + 1);
  });

  it("sends the same text the save counted", () => {
    const query = tooLongFormQuery({ body: " one\r\ntwo ", language: "de" });

    expect(query.get("body")).toBe("one\ntwo");
  });

  // Each Cyrillic letter is six characters in a URL.
  it("leaves out a body too long for a URL", () => {
    const query = tooLongFormQuery({ body: "я".repeat(maxProfileBody + 1), language: "ru" });

    expect(query.has("body")).toBe(false);
    expect(query.get("error")).toBe("too-long");
    expect(query.get("language")).toBe("ru");
  });
});
