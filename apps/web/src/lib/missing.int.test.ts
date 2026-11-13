import { classifier, closeDb, createDb, type Db, item, migrate, source, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { isDetailPath, isItemPath, missing, notFoundPath } from "./missing.ts";

describe("a page that isn't there", () => {
  let db: Db;
  let us = "";
  let ours = "";
  let theirs = "";
  let ourItem = "";
  let theirItem = "";
  let ourClassifier = "";

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values([
      { id: "us", name: "Us", email: "us@example.com" },
      { id: "them", name: "Them", email: "them@example.com" },
    ]);
    const [a, b] = await db
      .insert(workspace)
      .values([
        { name: "Ours", ownerUserId: "us" },
        { name: "Theirs", ownerUserId: "them" },
      ])
      .returning({ id: workspace.id });
    ours = a?.id ?? "";
    theirs = b?.id ?? "";
    us = "us";
    const captured = async (workspaceId: string) => {
      const [feed] = await db
        .insert(source)
        .values({
          workspaceId,
          type: "rss",
          name: `Blog ${workspaceId}`,
          config: { url: `https://feeds.test/${workspaceId}.rss` },
          schedule: "*/15 * * * *",
        })
        .returning({ id: source.id });
      const [row] = await db
        .insert(item)
        .values({ workspaceId, sourceId: feed?.id ?? "", externalId: "one", title: "An Item", body: "A body", raw: {} })
        .returning({ id: item.id });
      return row?.id ?? "";
    };
    ourItem = await captured(ours);
    theirItem = await captured(theirs);
    const [rule] = await db.insert(classifier).values({ workspaceId: ours, name: "Launches", kind: "deterministic", definition: {} }).returning({ id: classifier.id });
    ourClassifier = rule?.id ?? "";
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  const unknown = () => crypto.randomUUID();

  it("finds the Item a visitor asked for", async () => {
    expect(await missing(db, us, `/items/${ourItem}`)).toBe(false);
  });

  it("answers an unknown Item id as missing", async () => {
    expect(await missing(db, us, `/items/${unknown()}`)).toBe(true);
  });

  it("answers another Workspace's Item as missing, as it answers an unknown id", async () => {
    expect(await missing(db, us, `/items/${theirItem}`)).toBe(true);
  });

  it("answers a malformed Item id as missing, without asking Postgres", async () => {
    expect(await missing(db, us, "/items/not-a-uuid")).toBe(true);
  });

  it("finds the rule a visitor asked for", async () => {
    expect(await missing(db, us, `/rules/classifier/${ourClassifier}`)).toBe(false);
  });

  it("answers an unknown rule id as missing", async () => {
    expect(await missing(db, us, `/rules/classifier/${unknown()}`)).toBe(true);
  });

  it("answers a rule type that doesn't exist as missing", async () => {
    expect(await missing(db, us, `/rules/nonsense/${unknown()}`)).toBe(true);
  });

  it("leaves every other page to the app", async () => {
    for (const pathname of ["/", "/items", "/rules", "/rules/new", "/rules/classifier", notFoundPath]) {
      expect([pathname, await missing(db, us, pathname)]).toEqual([pathname, false]);
    }
  });
});

describe("which paths are a detail page", () => {
  it.each(["/items/3f0c2f4e-0000-4000-8000-000000000000", "/rules/classifier/3f0c2f4e-0000-4000-8000-000000000000"])(
    "covers %s",
    (pathname) => {
      expect(isDetailPath(pathname)).toBe(true);
    },
  );

  it.each(["/", "/items", "/items/a/b", "/rules", "/rules/classifier", "/rules/classifier/a/b", "/rules/new", "/settings"])(
    "leaves %s alone",
    (pathname) => {
      expect(isDetailPath(pathname)).toBe(false);
    },
  );
});

describe("which paths are an Item's own page", () => {
  it("covers an Item, and nothing deeper under it", () => {
    expect(isItemPath("/items/3f0c2f4e-0000-4000-8000-000000000000")).toBe(true);
    expect(isItemPath("/items/3f0c2f4e-0000-4000-8000-000000000000/more")).toBe(false);
    expect(isItemPath("/rules/classifier/3f0c2f4e-0000-4000-8000-000000000000")).toBe(false);
  });
});
