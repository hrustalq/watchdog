// One account owning several Workspaces: the table's own rules (docs: Security and privacy,
// "Deleting and exporting a Workspace"), and the migration that turns one-Workspace-per-user
// databases into them without touching a row.
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "./client.ts";
import { migrate } from "./migrate.ts";
import { user, workspace } from "./schema/index.ts";
import { migrateFirst, startPostgres } from "./testing/postgres.ts";

describe("the workspace table", () => {
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

  it("lets one account own several Workspaces", async () => {
    const ownerId = await account();

    await db.insert(workspace).values({ ownerUserId: ownerId, name: "Work" });
    await db.insert(workspace).values({ ownerUserId: ownerId, name: "Markets" });

    expect(await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.ownerUserId, ownerId))).toHaveLength(2);
  });

  it("refuses a second Workspace with the same name for one owner, and allows it for another", async () => {
    const ownerId = await account();
    await db.insert(workspace).values({ ownerUserId: ownerId, name: "Work" });

    await expect(db.insert(workspace).values({ ownerUserId: ownerId, name: "Work" })).rejects.toMatchObject({
      cause: { code: "23505", constraint: "workspace_owner_name_key" },
    });

    // The name is unique per owner, not across the install.
    await db.insert(workspace).values({ ownerUserId: await account(), name: "Work" });
  });
});

describe("migration 0033", () => {
  it("runs on a database where every user has one Workspace, and changes no row", async () => {
    const postgres = await startPostgres();
    try {
      // The 33 migrations before this one: through 0032, where owner_user_id is unique.
      await migrateFirst(postgres.url, 33);
      const db = createDb(postgres.url);
      try {
        const ownerId = crypto.randomUUID();
        await db.insert(user).values({ id: ownerId, name: "Owner", email: "owner@example.com" });
        const [before] = await db
          .insert(workspace)
          .values({ ownerUserId: ownerId, name: "Morning coffee" })
          .returning();
        // The schema this migration comes from: a second Workspace is refused outright.
        await expect(db.insert(workspace).values({ ownerUserId: ownerId, name: "Second" })).rejects.toMatchObject({
          cause: { code: "23505", constraint: "workspace_owner_user_id_unique" },
        });

        await migrate(postgres.url);

        const rows = await db.select().from(workspace).where(eq(workspace.ownerUserId, ownerId));
        expect(rows).toEqual([before]);
        // And the account may now own a second one, which is the migration's whole point.
        await db.insert(workspace).values({ ownerUserId: ownerId, name: "Second" });
      } finally {
        await closeDb(db);
      }
    } finally {
      await postgres.stop();
    }
  }, 180_000);
});
