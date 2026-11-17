// Which Workspace a request reads (docs: Security and privacy, "Deleting and exporting a Workspace"):
// the cookie is a preference, the owner's oldest is the fallback, and the first request makes one.
import { closeDb, createDb, type Db, eq, migrate, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createWorkspace, listWorkspaces, renameWorkspace, workspaceFor, workspaceName } from "./workspace.ts";

describe("workspaceName", () => {
  it("trims a name and refuses one that is empty or over a hundred characters", () => {
    expect(workspaceName("  Morning coffee  ")).toBe("Morning coffee");
    expect(workspaceName("")).toBeUndefined();
    expect(workspaceName("   ")).toBeUndefined();
    expect(workspaceName(undefined)).toBeUndefined();
    expect(workspaceName("x".repeat(100))).toBe("x".repeat(100));
    expect(workspaceName("x".repeat(101))).toBeUndefined();
  });
});

describe("the Workspace a request reads", () => {
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

  const account = async () => {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    return { id, email: `${id}@example.com` };
  };

  /** A Workspace at a set time, so "the oldest" is a fact of the test rather than of the clock. */
  const made = async (ownerId: string, name: string, createdAt: Date) => {
    const [row] = await db.insert(workspace).values({ ownerUserId: ownerId, name, createdAt }).returning();
    if (row === undefined) throw new Error("Expected a Workspace");
    return row;
  };

  it("reads the Workspace the cookie names, when the account owns it", async () => {
    const owner = await account();
    await made(owner.id, "Work", new Date("2026-01-01T00:00:00Z"));
    const markets = await made(owner.id, "Markets", new Date("2026-02-01T00:00:00Z"));

    expect((await workspaceFor(db, owner, markets.id)).id).toBe(markets.id);
  });

  it("falls back to the oldest when the cookie names another account's Workspace", async () => {
    const owner = await account();
    const work = await made(owner.id, "Work", new Date("2026-01-01T00:00:00Z"));
    await made(owner.id, "Markets", new Date("2026-02-01T00:00:00Z"));
    const theirs = await made((await account()).id, "Theirs", new Date("2025-01-01T00:00:00Z"));

    // Another account's id reads like a missing row: the oldest of this owner's, never theirs.
    expect((await workspaceFor(db, owner, theirs.id)).id).toBe(work.id);
  });

  it("falls back to the oldest when the cookie is stale or malformed", async () => {
    const owner = await account();
    const work = await made(owner.id, "Work", new Date("2026-01-01T00:00:00Z"));
    await made(owner.id, "Markets", new Date("2026-02-01T00:00:00Z"));

    expect((await workspaceFor(db, owner, crypto.randomUUID())).id).toBe(work.id);
    // A malformed id must never reach Postgres, which refuses one with an error rather than no row.
    expect((await workspaceFor(db, owner, "not-a-uuid")).id).toBe(work.id);
    expect((await workspaceFor(db, owner)).id).toBe(work.id);
  });

  it("creates one Workspace on the first request, even when two arrive at once", async () => {
    const owner = await account();

    const [first, second] = await Promise.all([workspaceFor(db, owner), workspaceFor(db, owner)]);

    expect(first.id).toBe(second.id);
    expect(first.name).toBe(owner.email.split("@")[0]);
    expect(await listWorkspaces(db, owner.id)).toHaveLength(1);
  });

  it("lists the account's Workspaces oldest first", async () => {
    const owner = await account();
    await made(owner.id, "Third", new Date("2026-03-01T00:00:00Z"));
    await made(owner.id, "First", new Date("2026-01-01T00:00:00Z"));
    await made(owner.id, "Second", new Date("2026-02-01T00:00:00Z"));

    expect((await listWorkspaces(db, owner.id)).map((one) => one.name)).toEqual(["First", "Second", "Third"]);
  });
});

describe("creating, renaming and one account's Workspaces", () => {
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

  const account = async () => {
    const id = crypto.randomUUID();
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` });
    return id;
  };

  it("creates a Workspace with the database's defaults, and refuses a name the account already has", async () => {
    const ownerId = await account();

    const created = await createWorkspace(db, ownerId, "Markets");
    if (created === undefined) throw new Error("Expected a Workspace");

    // The defaults are the database's, not the screen's.
    const [row] = await db.select().from(workspace).where(eq(workspace.id, created.id));
    expect(row).toMatchObject({
      timezone: "UTC",
      alertsPerHour: 20,
      burstWindowSeconds: 60,
      itemsRetentionDays: 90,
      logRetentionDays: 30,
      ownerUserId: ownerId,
    });

    expect(await createWorkspace(db, ownerId, "Markets")).toBeUndefined();
    // Another account may use the name.
    expect(await createWorkspace(db, await account(), "Markets")).toBeDefined();
  });

  it("renames one of the account's Workspaces, and refuses a sibling's name", async () => {
    const ownerId = await account();
    const work = await createWorkspace(db, ownerId, "Work");
    await createWorkspace(db, ownerId, "Markets");
    const id = work?.id ?? "";

    expect(await renameWorkspace(db, ownerId, id, "Desk")).toBe("renamed");
    expect(await db.query.workspace.findFirst({ where: (table) => eq(table.id, id) })).toMatchObject({
      name: "Desk",
    });

    expect(await renameWorkspace(db, ownerId, id, "Markets")).toBe("duplicate");
    expect(await renameWorkspace(db, await account(), id, "Someone else's")).toBe("missing");
    expect(await db.query.workspace.findFirst({ where: (table) => eq(table.id, id) })).toMatchObject({
      name: "Desk",
    });
  });
});
