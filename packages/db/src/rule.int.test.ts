import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "./client.ts";
import { migrate } from "./migrate.ts";
import {
  agentCall,
  classifier,
  correction,
  extractorRule,
  item,
  itemCategory,
  itemField,
  itemLog,
  modelConfig,
  profile,
  user,
  workspace,
} from "./schema/index.ts";
import { migrateFirst, startPostgres, type TestPostgres } from "./testing/postgres.ts";
import { only, seed } from "./testing/seed.ts";

const newModel = (workspaceId: string) => ({
  workspaceId,
  providerType: "openai-compatible" as const,
  baseUrl: "http://localhost:11434/v1",
  modelName: "llama3",
});

const newCorrection = (workspaceId: string, itemId: string | null) => ({
  workspaceId,
  itemId,
  kind: "rating" as const,
  itemTitle: "First post",
  itemSummary: "A summary",
  before: { severity: 2, importance: 2 },
  after: { severity: 5, importance: 4 },
});

const newAgentCall = (workspaceId: string, modelConfigId: string, itemId: string | null) => ({
  workspaceId,
  modelConfigId,
  itemId,
  purpose: "classify" as const,
  attempt: 1,
  latencyMs: 120,
  status: "ok" as const,
});

/** A seeded Workspace with a row in every table this issue adds. */
async function seedEverything(db: Db) {
  const seeded = await seed(db);
  const workspaceId = seeded.workspace.id;
  const itemId = seeded.item.id;
  const rule = { workspaceId, name: "rule", kind: "deterministic" as const, definition: {} };
  const classifierRow = only(await db.insert(classifier).values(rule).returning());
  const extractorRow = only(await db.insert(extractorRule).values(rule).returning());
  await db.insert(itemCategory).values({ itemId, category: "lead", classifierId: classifierRow.id });
  await db.insert(itemField).values({ itemId, name: "cve", value: "CVE-1", extractorRuleId: extractorRow.id });
  await db.insert(correction).values(newCorrection(workspaceId, itemId));
  await db.insert(profile).values({ workspaceId, body: "I build Watchdog." });
  const archivedModel = only(
    await db
      .insert(modelConfig)
      .values({ ...newModel(workspaceId), archivedAt: new Date() })
      .returning(),
  );
  const activeModel = only(await db.insert(modelConfig).values(newModel(workspaceId)).returning());
  await db.insert(agentCall).values(newAgentCall(workspaceId, archivedModel.id, itemId));
  await db.insert(agentCall).values(newAgentCall(workspaceId, activeModel.id, itemId));
  return { ...seeded, classifier: classifierRow, extractorRule: extractorRow, model: activeModel };
}

describe("rule, Rating, Correction, Profile, model and metering tables", () => {
  let postgres: TestPostgres;
  let db: Db;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  it("deleting an Item leaves its Corrections and agent_call rows, with item_id null", async () => {
    const seeded = await seedEverything(db);
    const workspaceId = seeded.workspace.id;

    await db.delete(item).where(eq(item.id, seeded.item.id));

    const corrections = await db.select().from(correction).where(eq(correction.workspaceId, workspaceId));
    expect(corrections).toMatchObject([{ itemId: null, itemTitle: "First post", itemSummary: "A summary" }]);
    const calls = await db.select().from(agentCall).where(eq(agentCall.workspaceId, workspaceId));
    expect(calls.map((call) => call.itemId)).toEqual([null, null]);
    // What belongs to the Item alone goes with it.
    expect(await db.select().from(itemCategory).where(eq(itemCategory.itemId, seeded.item.id))).toEqual([]);
    expect(await db.select().from(itemField).where(eq(itemField.itemId, seeded.item.id))).toEqual([]);
  });

  it("deleting a user removes everything above through the Workspace", async () => {
    const kept = await seedEverything(db);
    const gone = await seedEverything(db);
    const workspaceId = gone.workspace.id;

    await db.delete(user).where(eq(user.id, gone.owner.id));

    expect(await db.select().from(classifier).where(eq(classifier.workspaceId, workspaceId))).toEqual([]);
    expect(await db.select().from(extractorRule).where(eq(extractorRule.workspaceId, workspaceId))).toEqual([]);
    expect(await db.select().from(itemCategory).where(eq(itemCategory.itemId, gone.item.id))).toEqual([]);
    expect(await db.select().from(itemField).where(eq(itemField.itemId, gone.item.id))).toEqual([]);
    expect(await db.select().from(correction).where(eq(correction.workspaceId, workspaceId))).toEqual([]);
    expect(await db.select().from(profile).where(eq(profile.workspaceId, workspaceId))).toEqual([]);
    expect(await db.select().from(modelConfig).where(eq(modelConfig.workspaceId, workspaceId))).toEqual([]);
    expect(await db.select().from(agentCall).where(eq(agentCall.workspaceId, workspaceId))).toEqual([]);
    // The other user's rows stay.
    expect(await db.select().from(agentCall).where(eq(agentCall.workspaceId, kept.workspace.id))).toHaveLength(2);
    expect(await db.select().from(itemCategory).where(eq(itemCategory.itemId, kept.item.id))).toHaveLength(1);
  });

  it("refuses a second unarchived model_config in a Workspace", async () => {
    const seeded = await seedEverything(db);
    const other = await seed(db);

    await expect(db.insert(modelConfig).values(newModel(seeded.workspace.id))).rejects.toMatchObject({
      cause: { code: "23505", constraint: "model_config_workspace_id_active_key" },
    });

    // Archiving the active model makes room for its replacement, and other Workspaces aren't affected.
    await db.update(modelConfig).set({ archivedAt: new Date() }).where(eq(modelConfig.id, seeded.model.id));
    await db.insert(modelConfig).values(newModel(seeded.workspace.id));
    await db.insert(modelConfig).values(newModel(other.workspace.id));
    const active = await db
      .select()
      .from(modelConfig)
      .where(and(eq(modelConfig.workspaceId, seeded.workspace.id), sql`${modelConfig.archivedAt} is null`));
    expect(active).toHaveLength(1);
  });

  it("refuses to delete a model_config that agent_call rows point at", async () => {
    const seeded = await seedEverything(db);

    await expect(db.delete(modelConfig).where(eq(modelConfig.id, seeded.model.id))).rejects.toMatchObject({
      cause: { code: "23503", constraint: "agent_call_model_config_fk" },
    });
  });

  it("refuses an agent_call whose workspace_id isn't its model's Workspace", async () => {
    const seeded = await seedEverything(db);
    const other = await seed(db);

    await expect(
      db.insert(agentCall).values(newAgentCall(other.workspace.id, seeded.model.id, null)),
    ).rejects.toMatchObject({ cause: { code: "23503", constraint: "agent_call_model_config_fk" } });
  });

  it("refuses a second Correction with the same (item_id, kind)", async () => {
    const seeded = await seedEverything(db);
    const workspaceId = seeded.workspace.id;

    await expect(db.insert(correction).values(newCorrection(workspaceId, seeded.item.id))).rejects.toMatchObject({
      cause: { code: "23505", constraint: "correction_item_id_kind_key" },
    });

    // The other kind is a different Correction, and Corrections of deleted Items don't collide.
    await db.insert(correction).values({ ...newCorrection(workspaceId, seeded.item.id), kind: "categories" });
    await db.insert(correction).values(newCorrection(workspaceId, null));
    await db.insert(correction).values(newCorrection(workspaceId, null));
    const rows = await db.select().from(correction).where(eq(correction.workspaceId, workspaceId));
    expect(rows).toHaveLength(4);
  });

  it("reads a Workspace's latest Corrections from its index without sorting", async () => {
    const seeded = await seedEverything(db);

    // Tiny tables make a seq or bitmap scan cheapest, so forbid both to see which index the order can use.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const result = await tx.execute<{ "QUERY PLAN": string }>(sql`
        explain select * from correction
        where workspace_id = ${seeded.workspace.id}
        order by created_at desc
        limit 20`);
      return result.rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(plan).toContain("correction_workspace_id_created_at_idx");
    expect(plan).not.toMatch(/Sort/);
  });

  it("keeps Classifier and Extractor Rule names unique per Workspace", async () => {
    const seeded = await seedEverything(db);
    const other = await seed(db);
    const rule = { name: "rule", kind: "agent" as const, definition: {} };

    await expect(
      db.insert(classifier).values({ ...rule, workspaceId: seeded.workspace.id }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "classifier_workspace_id_name_key" } });
    await expect(
      db.insert(extractorRule).values({ ...rule, workspaceId: seeded.workspace.id }),
    ).rejects.toMatchObject({ cause: { code: "23505", constraint: "extractor_rule_workspace_id_name_key" } });

    await db.insert(classifier).values({ ...rule, workspaceId: other.workspace.id });
    await db.insert(extractorRule).values({ ...rule, workspaceId: other.workspace.id });
  });

  it("keeps Categories and extracted fields when their rule is deleted, with the rule's id null", async () => {
    const seeded = await seedEverything(db);

    await db.delete(classifier).where(eq(classifier.id, seeded.classifier.id));
    await db.delete(extractorRule).where(eq(extractorRule.id, seeded.extractorRule.id));

    expect(await db.select().from(itemCategory).where(eq(itemCategory.itemId, seeded.item.id))).toEqual([
      { itemId: seeded.item.id, category: "lead", classifierId: null },
    ]);
    expect(await db.select().from(itemField).where(eq(itemField.itemId, seeded.item.id))).toEqual([
      { itemId: seeded.item.id, name: "cve", value: "CVE-1", extractorRuleId: null },
    ]);
  });

  it("gives a new rule and Profile their defaults", async () => {
    const seeded = await seed(db);
    const workspaceId = seeded.workspace.id;

    const rule = only(
      await db.insert(classifier).values({ workspaceId, name: "new", kind: "agent", definition: { a: 1 } }).returning(),
    );
    expect(rule).toMatchObject({ enabled: true, definition: { a: 1 } });
    const saved = only(await db.insert(profile).values({ workspaceId, body: "" }).returning());
    expect(saved.outputLanguage).toBe("en");
  });

  it("stamps an edited rule from the database clock, the one captured_at uses", async () => {
    const seeded = await seed(db);
    const rule = only(
      await db
        .insert(classifier)
        .values({ workspaceId: seeded.workspace.id, name: "clock", kind: "agent", definition: {} })
        .returning(),
    );

    // now() is fixed for a transaction, so only a stamp the database wrote equals it exactly.
    const stamped = await db.transaction(async (tx) => {
      await tx.update(classifier).set({ enabled: false }).where(eq(classifier.id, rule.id));
      const { rows } = await tx.execute(
        sql`select ${classifier.updatedAt} = now() as "same" from ${classifier} where ${classifier.id} = ${rule.id}`,
      );
      return rows[0]?.same;
    });
    expect(stamped).toBe(true);
  });

  it.each([
    ["classifier", "kind", "classifier_kind_check"],
    ["extractor_rule", "kind", "extractor_rule_kind_check"],
    ["correction", "kind", "correction_kind_check"],
    ["model_config", "provider_type", "model_config_provider_type_check"],
    ["agent_call", "purpose", "agent_call_purpose_check"],
    ["agent_call", "status", "agent_call_status_check"],
  ])("refuses an unknown %s.%s by a check", async (table, column, constraint) => {
    await seedEverything(db);

    await expect(
      db.execute(sql`update ${sql.identifier(table)} set ${sql.identifier(column)} = 'unknown'`),
    ).rejects.toMatchObject({ cause: { code: "23514", constraint } });
  });

  it("loads the new rows through the relations", async () => {
    const seeded = await seedEverything(db);

    const loaded = await db.query.workspace.findFirst({
      where: eq(workspace.id, seeded.workspace.id),
      with: {
        classifiers: true,
        extractorRules: true,
        corrections: true,
        profile: true,
        modelConfigs: { with: { agentCalls: true } },
        items: { with: { categories: { with: { classifier: true } }, fields: { with: { extractorRule: true } } } },
      },
    });

    expect(loaded?.classifiers).toHaveLength(1);
    expect(loaded?.extractorRules).toHaveLength(1);
    expect(loaded?.corrections).toHaveLength(1);
    expect(loaded?.profile?.body).toBe("I build Watchdog.");
    expect(loaded?.modelConfigs.flatMap((model) => model.agentCalls)).toHaveLength(2);
    expect(loaded?.items[0]?.categories[0]?.classifier?.name).toBe("rule");
    expect(loaded?.items[0]?.fields[0]?.extractorRule?.name).toBe("rule");
  });

  it("applies migration 0006 on a database at 0005 and keeps its Items unrated", async () => {
    await db.execute(sql`create database at_0005`);
    const url = new URL(postgres.url);
    url.pathname = "/at_0005";
    await migrateFirst(url.href, 6);
    const old = createDb(url.href);
    try {
      await old.execute(sql`insert into "user" (id, name, email) values ('u', 'O', 'o@example.com')`);
      await old.execute(sql`insert into workspace (name, owner_user_id) values ('Workspace', 'u')`);
      await old.execute(sql`
        insert into source (workspace_id, type, name, config, schedule)
        select id, 'rss', 'Blog', '{"url": "https://example.com/feed.xml"}', '*/15 * * * *' from workspace`);
      await old.execute(sql`
        insert into item (workspace_id, source_id, external_id, body, raw)
        select workspace_id, id, 'guid-1', 'Hello', '{}' from source`);
    } finally {
      await closeDb(old);
    }

    await migrate(url.href);

    const upgraded = createDb(url.href);
    try {
      const kept = only(await upgraded.select().from(item));
      expect(kept).toMatchObject({
        externalId: "guid-1",
        severity: null,
        importance: null,
        classifiedAt: null,
        ratedAt: null,
        ratingCorrectedAt: null,
        categoriesCorrectedAt: null,
        processedAt: null,
      });
      await upgraded.insert(itemLog).values({ itemId: kept.id, stage: "classify", message: "Classified" });
    } finally {
      await closeDb(upgraded);
    }
  }, 60_000);
});
