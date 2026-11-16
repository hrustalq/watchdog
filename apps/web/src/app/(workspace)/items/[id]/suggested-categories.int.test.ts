// What the Item detail page's add box offers (docs: Processing pipeline, "Corrections"). The list is
// the Workspace's own, so another Workspace's Categories never appear in it.
import {
  classifier,
  closeDb,
  createDb,
  type Db,
  eq,
  item,
  itemCategory,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { correctCategories, maxCategoryLength } from "@/lib/corrections";
import { knownCategories } from "@/lib/rules";

/** The value, which the test expects to be there. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

describe("The Categories the add box offers", () => {
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

  /** A new Workspace with one RSS Source, and one Item to open. */
  async function seed() {
    const ownerId = crypto.randomUUID();
    await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
    const [created] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: ownerId }).returning();
    const workspaceId = present(created).id;
    const [feed] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "rss",
        name: "Blog",
        config: { url: `https://feeds.test/${crypto.randomUUID()}.rss` },
        schedule: "*/15 * * * *",
      })
      .returning();
    const [target] = await db
      .insert(item)
      .values({
        workspaceId,
        sourceId: present(feed).id,
        externalId: crypto.randomUUID(),
        title: "A post",
        body: "Body",
        raw: {},
      })
      .returning();
    return { workspaceId, sourceId: present(feed).id, itemId: present(target).id };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  /** Another Item in the Workspace, carrying `category`. */
  async function categoryOnAnotherItem({ workspaceId, sourceId }: Seeded, category: string) {
    const [created] = await db
      .insert(item)
      .values({ workspaceId, sourceId, externalId: crypto.randomUUID(), title: "Another post", body: "", raw: {} })
      .returning();
    await db.insert(itemCategory).values({ itemId: present(created).id, category });
  }

  const categoriesOn = async (itemId: string) =>
    (await db.select().from(itemCategory).where(eq(itemCategory.itemId, itemId)))
      .map((row) => row.category)
      .sort();

  it("takes them from the Workspace's Items and Classifiers, and none from another Workspace", async () => {
    const us = await seed();
    const them = await seed();
    await categoryOnAnotherItem(us, "on-an-item");
    await categoryOnAnotherItem(them, "theirs-on-an-item");
    await db.insert(classifier).values([
      {
        workspaceId: us.workspaceId,
        name: "Sort",
        kind: "deterministic",
        definition: { classifier: "Sort", when: { field: "title", op: "exists" }, assign: ["assigned-by-a-rule"] },
      },
      {
        workspaceId: us.workspaceId,
        name: "Choose",
        kind: "agent",
        definition: { classifier: "Choose", prompt: "Sort it.", categories: ["declared-by-an-agent"] },
      },
      {
        workspaceId: them.workspaceId,
        name: "Theirs",
        kind: "deterministic",
        definition: { classifier: "Theirs", when: { field: "title", op: "exists" }, assign: ["theirs-by-a-rule"] },
      },
    ]);

    expect(await knownCategories(db, us.workspaceId)).toEqual([
      "assigned-by-a-rule",
      "declared-by-an-agent",
      "on-an-item",
    ]);
    expect(await knownCategories(db, them.workspaceId)).toEqual(["theirs-by-a-rule", "theirs-on-an-item"]);
  });

  it("still adds a Category the Workspace doesn't know", async () => {
    const { workspaceId, itemId } = await seed();
    const invented = "x".repeat(maxCategoryLength);

    expect(await knownCategories(db, workspaceId)).toEqual([]);
    await correctCategories(db, workspaceId, itemId, { add: invented });

    expect(await categoriesOn(itemId)).toEqual([invented]);
  });
});
