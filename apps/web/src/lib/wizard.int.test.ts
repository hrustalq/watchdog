import { randomBytes, randomUUID } from "node:crypto";
import { draftToYaml } from "@watchdog/core/rules/draft";
import { egressPolicy, starterRulesFor } from "@watchdog/core";
import {
  action,
  actionDestination,
  classifier,
  closeDb,
  createDb,
  type Db,
  destination,
  eq,
  extractorRule,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { addEmailDestination, type DestinationDeps } from "./destinations.ts";
import { declaredFields, importanceAlertExists, ruleNames, saveRule } from "./rules.ts";
import { guidedSource } from "./sources.ts";

const sent: { to: string; subject: string; text: string }[] = [];
const deps: DestinationDeps = {
  mailer: {
    send: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  },
  alertFrom: "alerts@example.com",
  baseURL: "http://localhost:3000",
  encryptionKey: randomBytes(32),
  egressAllows: egressPolicy({ mode: "hosted", egressAllowlist: [] }),
};
const owner = { email: "guided@example.com", emailVerified: true };

describe("the guided setup's writes", () => {
  let db: Db;
  let ours = "";
  let theirs = "";
  let named = 0;
  const newName = () => {
    named += 1;
    return `Destination ${String(named)}`;
  };

  beforeAll(async () => {
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values([
      { id: "guided-us", name: "Us", email: "guided@example.com" },
      { id: "guided-them", name: "Them", email: "guided-them@example.com" },
    ]);
    const [a, b] = await db
      .insert(workspace)
      .values([
        { name: "Ours", ownerUserId: "guided-us" },
        { name: "Theirs", ownerUserId: "guided-them" },
      ])
      .returning();
    ours = a?.id ?? "";
    theirs = b?.id ?? "";
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** A Source of the Workspace the guided setup can build starters for. */
  async function seedSource(
    workspaceId: string,
    type: NonNullable<(typeof source.$inferInsert)["type"]> = "rss",
    config: NonNullable<(typeof source.$inferInsert)["config"]> = {
      url: `https://example.com/${randomUUID()}.xml`,
    },
  ) {
    const [saved] = await db
      .insert(source)
      .values({ workspaceId, type, name: "Watched", config, schedule: "*/15 * * * *" })
      .returning();
    const row = saved;
    if (row === undefined) throw new Error("The Source wasn't saved");
    return row;
  }

  it("saves every starter through the rule save path and then offers none of them again", async () => {
    const watched = await seedSource(ours);
    const starters = starterRulesFor(
      { type: watched.type, config: watched.config },
      { declaredFields: [], existingNames: { classifier: [], extractor: [] } },
    );
    expect(starters).toHaveLength(3);

    for (const starter of starters) {
      expect(await saveRule(db, ours, null, draftToYaml(starter.draft), "self-hosted", undefined)).toMatchObject({
        saved: { type: starter.type },
      });
    }

    const [classifiers, extractors] = await Promise.all([
      db.select({ name: classifier.name }).from(classifier).where(eq(classifier.workspaceId, ours)),
      db.select({ name: extractorRule.name }).from(extractorRule).where(eq(extractorRule.workspaceId, ours)),
    ]);
    expect(classifiers.map(({ name }) => name).sort()).toEqual(["Bug reports", "Feature requests"]);
    expect(extractors.map(({ name }) => name)).toEqual(["Version"]);

    const [declared, names] = await Promise.all([declaredFields(db, ours), ruleNames(db, ours)]);
    expect(
      starterRulesFor(
        { type: watched.type, config: watched.config },
        { declaredFields: declared.map(({ name }) => name), existingNames: names },
      ),
    ).toEqual([]);
  });

  it("saves the Importance 4 alert enabled, pointed at the Destination it was offered for", async () => {
    await seedSource(ours);
    const name = newName();
    const added = await addEmailDestination(db, deps, ours, owner, { name, address: owner.email });
    if (added.destination === undefined) throw new Error(`Not added: ${added.problem}`);

    const draft = {
      action: "Importance 4 alerts",
      when: { field: "importance", op: "gte", value: 4 },
      kind: "alert",
      destinations: [name],
    };
    const saved = await saveRule(db, ours, null, draftToYaml(draft), "self-hosted", undefined);
    if (!("saved" in saved)) throw new Error(saved.problems.map(({ message }) => message).join(", "));

    const [row] = await db.select().from(action).where(eq(action.id, saved.saved.id));
    expect(row).toMatchObject({ name: "Importance 4 alerts", enabled: true, kind: "alert" });
    const pointedAt = await db.select().from(actionDestination).where(eq(actionDestination.actionId, saved.saved.id));
    expect(pointedAt.map(({ destinationId }) => destinationId)).toEqual([added.destination.id]);
    // The step can be submitted again from Back: the same alert to the same Destination is already there.
    expect(await importanceAlertExists(db, ours, added.destination.id)).toBe(true);
    const otherName = newName();
    const other = await addEmailDestination(db, deps, ours, owner, { name: otherName, address: "other@example.com" });
    if (other.destination === undefined) throw new Error(`Not added: ${other.problem}`);
    expect(await importanceAlertExists(db, ours, other.destination.id)).toBe(false);
    expect(await importanceAlertExists(db, theirs, added.destination.id)).toBe(false);
    // Saved enabled, as the step promises: it can fire on the next Item captured after it.
    expect(row?.updatedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("leaves a saved rule in place when a Destination is refused", async () => {
    await seedSource(ours);
    const name = newName();
    const first = await addEmailDestination(db, deps, ours, owner, { name, address: "first@example.com" });
    expect(first.destination).toBeDefined();

    const saved = await saveRule(
      db,
      ours,
      null,
      draftToYaml({ classifier: "Guided classifier", when: { field: "title", op: "contains", value: "release" }, assign: ["release"] }),
      "self-hosted",
      undefined,
    );
    expect(saved).toMatchObject({ saved: { type: "classifier" } });

    const refused = await addEmailDestination(db, deps, ours, owner, { name, address: "second@example.com" });
    expect(refused).toEqual({ problem: "duplicate-name" });

    const rows = await db.select().from(classifier).where(eq(classifier.workspaceId, ours));
    expect(rows.some(({ name: ruleName }) => ruleName === "Guided classifier")).toBe(true);
    const destinations = await db.select().from(destination).where(eq(destination.workspaceId, ours));
    expect(destinations.filter((row) => row.name === name)).toHaveLength(1);
  });

  it("reads a Source only in its own Workspace, and a malformed id as missing", async () => {
    const watched = await seedSource(ours);
    expect((await guidedSource(db, ours, watched.id))?.id).toBe(watched.id);
    expect(await guidedSource(db, theirs, watched.id)).toBeUndefined();
    expect(await guidedSource(db, ours, "not-a-uuid")).toBeUndefined();
    expect(await guidedSource(db, ours, randomUUID())).toBeUndefined();
  });
});
