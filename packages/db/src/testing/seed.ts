import type { Db } from "../client.ts";
import { item, source, user, workspace } from "../schema/index.ts";

/** The one row a query returned. */
export function only<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined || rows.length > 1) throw new Error(`Expected one row, got ${String(rows.length)}`);
  return row;
}

/**
 * A user with a Workspace, one RSS Source and one Item. Ids and emails carry a random suffix, so
 * tests sharing one database don't collide.
 */
export async function seed(db: Db) {
  const id = crypto.randomUUID();
  const owner = only(
    await db.insert(user).values({ id, name: "Owner", email: `${id}@example.com` }).returning(),
  );
  const ws = only(
    await db.insert(workspace).values({ name: "Workspace", ownerUserId: owner.id }).returning(),
  );
  const src = only(
    await db
      .insert(source)
      .values({
        workspaceId: ws.id,
        type: "rss",
        name: "Blog",
        config: { url: "https://example.com/feed.xml" },
        schedule: "*/15 * * * *",
      })
      .returning(),
  );
  const captured = only(
    await db
      .insert(item)
      .values({
        workspaceId: ws.id,
        sourceId: src.id,
        externalId: "guid-1",
        title: "First post",
        body: "Hello",
        raw: { guid: "guid-1" },
      })
      .returning(),
  );
  return { owner, workspace: ws, source: src, item: captured };
}

/** Two Workspaces, each with its own owner, as their ids. */
export async function twoWorkspaces(db: Db) {
  const suffix = crypto.randomUUID();
  await db.insert(user).values([
    { id: `a-${suffix}`, name: "A", email: `a-${suffix}@example.com` },
    { id: `b-${suffix}`, name: "B", email: `b-${suffix}@example.com` },
  ]);
  const rows = await db
    .insert(workspace)
    .values([
      { name: "A", ownerUserId: `a-${suffix}` },
      { name: "B", ownerUserId: `b-${suffix}` },
    ])
    .returning({ id: workspace.id });
  return rows.map((row) => row.id);
}
