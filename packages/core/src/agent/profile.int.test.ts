import { closeDb, createDb, type Db, migrate, profile, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { loadProfile } from "./profile.ts";

describe("loadProfile", () => {
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

  it("returns an empty body and en for a Workspace with no row", async () => {
    expect(await loadProfile(db, await newWorkspace())).toEqual({ body: "", outputLanguage: "en" });
  });

  it("returns the Workspace's saved body and language", async () => {
    const workspaceId = await newWorkspace();
    await db.insert(profile).values({ workspaceId, body: "I build Watchdog.", outputLanguage: "de" });

    expect(await loadProfile(db, workspaceId)).toEqual({ body: "I build Watchdog.", outputLanguage: "de" });
  });

  it("never reads another Workspace's Profile", async () => {
    const owner = await newWorkspace();
    const other = await newWorkspace();
    await db.insert(profile).values({ workspaceId: owner, body: "Private", outputLanguage: "fr" });

    expect(await loadProfile(db, other)).toEqual({ body: "", outputLanguage: "en" });
  });
});
