import { action, actionDestination, closeDb, createDb, type Db, destination, eq, migrate, user, workspace } from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { unsubscribeUrl } from "@watchdog/core";
import { beforeAll, describe, expect, it } from "vitest";
import { unsubscribe } from "./unsubscribe.ts";

const secret = "a-better-auth-secret-of-at-least-32-chars";
const saved = new Date("2026-11-01T00:00:00Z");

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

describe("unsubscribing from a Digest", () => {
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

  /** A Digest on these email Destinations, and the token a mail to each would carry. */
  async function seed(names: string[]) {
    const ownerId = crypto.randomUUID();
    await db.insert(user).values({ id: ownerId, name: "Owner", email: `${ownerId}@example.com` });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: ownerId }).returning();
    const workspaceId = present(ws).id;
    const ids = [];
    for (const name of names) {
      const [row] = await db
        .insert(destination)
        .values({ workspaceId, type: "email", name, config: { address: `${name}@example.com` }, confirmedAt: saved })
        .returning();
      ids.push(present(row).id);
    }
    const [digest] = await db
      .insert(action)
      .values({
        workspaceId,
        name: "Morning",
        kind: "digest",
        definition: { action: "Morning", when: { field: "severity", op: "gte", value: 1 }, kind: "digest", schedule: "0 8 * * *", destinations: ids },
        updatedAt: saved,
      })
      .returning();
    const actionId = present(digest).id;
    await db.insert(actionDestination).values(ids.map((destinationId) => ({ actionId, destinationId })));
    const tokenFor = (destinationId: string) =>
      new URL(unsubscribeUrl("https://watchdog.test", secret, actionId, destinationId)).searchParams.get("token") ?? "";
    const digestRow = async () => present((await db.select().from(action).where(eq(action.id, actionId)))[0]);
    const pointsAt = async () =>
      (await db.select().from(actionDestination).where(eq(actionDestination.actionId, actionId))).map((row) => row.destinationId);
    return { ids, tokenFor, digestRow, pointsAt };
  }

  it("removes that Destination from that Digest without a session, leaving the rest and updated_at", async () => {
    const { ids, tokenFor, digestRow, pointsAt } = await seed(["work", "home"]);
    const [work, home] = [present(ids[0]), present(ids[1])];

    expect(await unsubscribe(db, tokenFor(work), secret)).toBe("removed");

    expect(await pointsAt()).toEqual([home]);
    const row = await digestRow();
    expect(row).toMatchObject({ enabled: true, updatedAt: saved });
    expect(row.definition).toMatchObject({ destinations: [home] });
    // A second press finds nothing to do.
    expect(await unsubscribe(db, tokenFor(work), secret)).toBe("already");
  });

  it("disables a Digest instead when it was the only Destination, and keeps it", async () => {
    const { ids, tokenFor, digestRow, pointsAt } = await seed(["only"]);

    expect(await unsubscribe(db, tokenFor(present(ids[0])), secret)).toBe("disabled");

    expect(await pointsAt()).toEqual(ids);
    expect(await digestRow()).toMatchObject({ enabled: false, updatedAt: saved });
    expect(await unsubscribe(db, tokenFor(present(ids[0])), secret)).toBe("already");
  });

  it("refuses a tampered token and changes nothing", async () => {
    const { ids, tokenFor, pointsAt } = await seed(["work", "home"]);
    const token = tokenFor(present(ids[0]));
    const tampered = `${token.slice(0, -4)}${token.endsWith("AAAA") ? "BBBB" : "AAAA"}`;

    expect(await unsubscribe(db, tampered, secret)).toBe("invalid");
    expect(await unsubscribe(db, token, "another-secret-of-at-least-32-characters")).toBe("invalid");
    expect(await pointsAt()).toHaveLength(2);
  });
});
