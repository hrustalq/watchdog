import { processItem, ruleSchema } from "@watchdog/core";
import { draftToYaml } from "@watchdog/core/rules/draft";
import {
  classifier,
  closeDb,
  createDb,
  type Db,
  eq,
  extractorRule,
  item,
  itemCategory,
  migrate,
  modelConfig,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { blankRule, readDraft, setAt } from "./rule-draft.ts";
import {
  getRule,
  listRules,
  problemsInDraft,
  removeRule,
  type RuleTarget,
  saveRule,
  setRuleEnabled,
} from "./rules.ts";

const unique = () => crypto.randomUUID();

const classifierYaml = (name = unique()) => `classifier: ${name}
when:
  all:
    - field: source.type
      op: is
      value: rss
    - field: title
      op: matches
      value: (?i)launch|introducing
    - not:
        field: author
        op: in
        value:
          - me
assign:
  - competitor-launch
`;

const extractorYaml = (field: string, name = unique()) => `extractor: ${name}
when:
  field: category
  op: is
  value: security-advisory
fields:
  - name: ${field}
    type: string
    from: title
    regex: (CVE-\\d+-\\d+)
`;

const agentClassifierYaml = (name = unique()) => `classifier: ${name}
prompt: Decide whether this is a sales lead.
categories:
  - lead
`;

describe("Rules", () => {
  let db: Db;
  let ours = "";
  let theirs = "";

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
      .returning();
    ours = a?.id ?? "";
    theirs = b?.id ?? "";
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** Saves a rule that has to be valid, and returns where it went. */
  async function saved(workspaceId: string, yaml: string, target: RuleTarget | null = null) {
    const result = await saveRule(db, workspaceId, target, yaml);
    if ("problems" in result) throw new Error(`Not saved: ${JSON.stringify(result.problems)}`);
    return result.saved;
  }

  async function problems(yaml: string, target: RuleTarget | null = null, workspaceId = ours) {
    const result = await saveRule(db, workspaceId, target, yaml);
    if ("saved" in result) throw new Error("Expected the rule to be refused");
    return result.problems;
  }

  describe("saving", () => {
    it("shows a Classifier saved from the form identically in YAML", async () => {
      const fromForm = setAt(
        setAt(setAt(blankRule("classifier", "deterministic"), ["classifier"], unique()), ["when", "value"], "launch"),
        ["assign"],
        ["competitor-launch", "news"],
      );
      const yaml = draftToYaml(fromForm);

      const { type, id } = await saved(ours, yaml);

      expect((await getRule(db, ours, type, id))?.yaml).toBe(yaml);
    });

    it("shows an edit made in YAML in what the form reads", async () => {
      const { type, id } = await saved(ours, classifierYaml());
      const yaml = (await getRule(db, ours, type, id))?.yaml ?? "";

      await saved(ours, yaml.replace("competitor-launch", "launch"), { type, id });

      const read = readDraft((await getRule(db, ours, type, id))?.yaml ?? "");
      expect("draft" in read && read.draft.assign).toEqual(["launch"]);
    });

    it("gives back the YAML it was given, in the model's order, though jsonb sorts its keys", async () => {
      for (const yaml of [classifierYaml(), extractorYaml(unique()), agentClassifierYaml()]) {
        const { type, id } = await saved(ours, yaml);
        expect((await getRule(db, ours, type, id))?.yaml).toBe(yaml);
      }
    });

    it.each([
      ["a deterministic Classifier", "classifier", "deterministic", () => classifierYaml()],
      ["an Agent-backed Classifier", "classifier", "agent", () => agentClassifierYaml()],
      ["a deterministic Extractor Rule", "extractor", "deterministic", () => extractorYaml(unique())],
      [
        "an Agent-backed Extractor Rule",
        "extractor",
        "agent",
        () => `extractor: ${unique()}\nwhen: { field: title, op: exists }\nprompt: Pull it out.\nfields: [{ name: ${unique()}, type: string }]\n`,
      ],
    ] as const)("stores %s under its name and kind, enabled", async (_, type, kind, yaml) => {
      const text = yaml();
      const result = await saved(ours, text);
      expect(result.type).toBe(type);

      const stored = await getRule(db, ours, type, result.id);
      expect(stored).toMatchObject({ kind, enabled: true });
      expect(text).toContain(`: ${stored?.name ?? "missing"}\n`);
      expect(ruleSchema.safeParse(readDefinition(stored?.yaml ?? "")).success).toBe(true);
    });

    it("renames the rule and changes its kind when an edit does", async () => {
      const { type, id } = await saved(ours, classifierYaml());
      const name = unique();
      await saved(ours, agentClassifierYaml(name), { type, id });
      expect(await getRule(db, ours, type, id)).toMatchObject({ name, kind: "agent" });
    });

    it("keeps a rule's enabled flag through an edit", async () => {
      const { type, id } = await saved(ours, classifierYaml());
      await setRuleEnabled(db, ours, type, id, false);
      await saved(ours, classifierYaml(), { type, id });
      expect(await getRule(db, ours, type, id)).toMatchObject({ enabled: false });
    });

    it("refuses a regex that doesn't compile, beside the regex", async () => {
      const yaml = `classifier: ${unique()}\nwhen:\n  all:\n    - { field: title, op: matches, value: "(" }\nassign: [x]\n`;
      expect(await problems(yaml)).toEqual([
        { path: "when.all.0.value", message: expect.stringContaining("isn't a regular expression") },
      ]);
    });

    it("refuses a regex field with no capture group, beside it", async () => {
      const yaml = extractorYaml(unique()).replace("(CVE-\\d+-\\d+)", "CVE");
      expect(await problems(yaml)).toEqual([
        { path: "fields.0.regex", message: expect.stringContaining("no capture group") },
      ]);
    });

    it.each([
      ["classifier", `classifier: ${unique()}\nwhen: { field: severity, op: gte, value: 4 }\nassign: [x]\n`],
      ["extractor", `extractor: ${unique()}\nwhen: { field: severity, op: gte, value: 4 }\nfields: [{ name: a, type: string, jsonpath: "$" }]\n`],
    ])("refuses an out-of-stage field on a %s, beside the field", async (_, yaml) => {
      expect(await problems(yaml)).toEqual([
        { path: "when.field", message: expect.stringContaining('"severity"') },
      ]);
    });

    it("refuses a Category test on a Classifier, naming the field", async () => {
      const yaml = `classifier: ${unique()}\nwhen: { field: category, op: is, value: x }\nassign: [x]\n`;
      expect(await problems(yaml)).toEqual([{ path: "when.field", message: expect.stringContaining('"category"') }]);
    });

    it.each([
      ["text it can't parse", "classifier: [", /Flow sequence/],
      ["YAML nested too deeply", "[".repeat(200_000), /./],
      ["nothing at all", "", /starts with/],
      ["a list", "- a\n", /starts with/],
    ])("refuses %s as a whole", async (_, yaml, message) => {
      const [problem] = await problems(yaml);
      expect(problem?.path).toBe("");
      expect(problem?.message).toMatch(message);
    });

    it.each([
      ["a blank name", (yaml: string) => yaml.replace(/^classifier: .*$/m, 'classifier: "  "'), "classifier", "blank"],
      ["no name value", (yaml: string) => yaml.replace(/^classifier: .*$/m, "classifier:"), "classifier", "text"],
      ["no Categories", (yaml: string) => yaml.replace(/assign:[\s\S]*$/, "assign: []\n"), "assign", "at least one"],
      ["a key it doesn't know", (yaml: string) => `${yaml}note: hi\n`, "", '"note"'],
    ])("says plainly what's wrong with %s", async (_, change, path, message) => {
      expect(await problems(change(classifierYaml()))).toEqual([
        { path, message: expect.stringContaining(message) },
      ]);
    });

    it("says which types a field can have", async () => {
      const yaml = extractorYaml(unique()).replace("type: string", "type: date");
      expect(await problems(yaml)).toEqual([
        { path: "fields.0.type", message: expect.stringContaining("string, integer") },
      ]);
    });

    it("refuses a name over 200 characters, which the unique index couldn't hold", async () => {
      expect(await problems(classifierYaml("x".repeat(201)))).toEqual([
        { path: "classifier", message: expect.stringContaining("200") },
      ]);
      expect(await problems(classifierYaml("x".repeat(9000)))).toHaveLength(1);
    });

    it.each([
      ["a NUL", String.raw`"a\0b"`],
      ["half a surrogate pair", String.raw`"a\uD800b"`],
    ])("refuses %s, which Postgres can't store", async (_, value) => {
      const yaml = `classifier: ${unique()}\nwhen: { field: title, op: contains, value: ${value} }\nassign: [x]\n`;
      expect(await problems(yaml)).toEqual([{ path: "", message: expect.stringContaining("can't store") }]);
    });

    it("stores text that only looks like an escape of those", async () => {
      const yaml = `classifier: ${unique()}\nwhen: { field: title, op: contains, value: '\\u0000 \\ud800' }\nassign: [x]\n`;
      await saved(ours, yaml);
    });

    it("refuses a second rule of the same type with the same name, beside the name", async () => {
      const name = unique();
      await saved(ours, classifierYaml(name));
      expect(await problems(classifierYaml(name))).toEqual([
        { path: "classifier", message: expect.stringContaining(name) },
      ]);
    });

    it("lets a Classifier and an Extractor Rule share a name, and another Workspace use it", async () => {
      const name = unique();
      await saved(ours, classifierYaml(name));
      await saved(ours, extractorYaml(unique(), name));
      await saved(theirs, classifierYaml(name));
    });

    it("refuses turning a saved Classifier into an Extractor Rule", async () => {
      const { type, id } = await saved(ours, classifierYaml());
      expect(await problems(extractorYaml(unique()), { type, id })).toEqual([
        { path: "", message: expect.stringContaining("can't become") },
      ]);
    });
  });

  describe("field names across Extractor Rules", () => {
    it("refuses a field another Extractor Rule declares, beside the field", async () => {
      const field = unique();
      const other = unique();
      await saved(ours, extractorYaml(field, other));

      const reply = await problems(extractorYaml(field));

      expect(reply).toEqual([{ path: "fields.0.name", message: expect.stringContaining(other) }]);
      expect(reply[0]?.message).toContain(field);
    });

    it("counts a disabled rule's fields and an Agent-backed rule's", async () => {
      const disabled = unique();
      const { id } = await saved(ours, extractorYaml(disabled));
      await setRuleEnabled(db, ours, "extractor", id, false);
      expect(await problems(extractorYaml(disabled))).toHaveLength(1);

      const agentField = unique();
      await saved(ours, `extractor: ${unique()}\nwhen: { field: title, op: exists }\nprompt: P\nfields: [{ name: ${agentField}, type: string }]\n`);
      expect(await problems(extractorYaml(agentField))).toHaveLength(1);
    });

    it("lets a rule keep its own field names through an edit", async () => {
      const field = unique();
      const target = await saved(ours, extractorYaml(field));
      await saved(ours, extractorYaml(field), target);
    });

    it("frees a field name when the rule declaring it is deleted", async () => {
      const field = unique();
      const { id } = await saved(ours, extractorYaml(field));
      await removeRule(db, ours, "extractor", id);
      await saved(ours, extractorYaml(field));
    });

    it("doesn't count another Workspace's rules", async () => {
      const field = unique();
      await saved(theirs, extractorYaml(field));
      await saved(ours, extractorYaml(field));
    });

    it("lets only one of two concurrent saves declare a field", async () => {
      const field = unique();
      const results = await Promise.all([
        saveRule(db, ours, null, extractorYaml(field)),
        saveRule(db, ours, null, extractorYaml(field)),
      ]);
      expect(results.filter((result) => "saved" in result)).toHaveLength(1);
    });

    it("isn't held up by a rule whose definition no longer parses", async () => {
      await db.insert(extractorRule).values({
        workspaceId: ours,
        name: unique(),
        kind: "deterministic",
        definition: { extractor: "old", fields: "not a list" },
      });
      await saved(ours, extractorYaml(unique()));
    });
  });

  describe("checking a draft the page was sent back with", () => {
    it("finds what saving would refuse, without saving", async () => {
      const field = unique();
      await saved(ours, extractorYaml(field));
      const name = unique();
      expect(await problemsInDraft(db, ours, null, extractorYaml(field, name))).toEqual([
        { path: "fields.0.name", message: expect.stringContaining(field) },
      ]);
      expect((await listRules(db, ours)).extractorRules.map((rule) => rule.name)).not.toContain(name);
    });

    it("finds nothing in a draft that would save", async () => {
      expect(await problemsInDraft(db, ours, null, classifierYaml())).toEqual([]);
    });

    it("doesn't count an edited rule as its own conflict", async () => {
      const field = unique();
      const target = await saved(ours, extractorYaml(field));
      expect(await problemsInDraft(db, ours, target, extractorYaml(field))).toEqual([]);
    });
  });

  describe("disabling", () => {
    async function capture(sourceId: string, title: string) {
      const [row] = await db
        .insert(item)
        .values({ workspaceId: ours, sourceId, externalId: unique(), title, body: "", raw: {} })
        .returning({ id: item.id });
      if (row === undefined) throw new Error("Not captured");
      await processItem(db, row.id, {});
      const rows = await db.select().from(itemCategory).where(eq(itemCategory.itemId, row.id));
      return rows.map((category) => category.category);
    }

    it("stops a rule from running on the next captured Item, until it's enabled again", async () => {
      const [feed] = await db
        .insert(source)
        .values({ workspaceId: ours, type: "rss", name: "Blog", config: { url: `https://example.com/${unique()}` }, schedule: "*/15 * * * *" })
        .returning({ id: source.id });
      const sourceId = feed?.id ?? "";
      const category = unique();
      const yaml = `classifier: ${unique()}\nwhen: { field: title, op: contains, value: launch }\nassign: [${category}]\n`;
      const { id } = await saved(ours, yaml);

      // Other tests' rules run on these Items too, so only this rule's Category counts.
      expect(await capture(sourceId, "A launch")).toContain(category);

      expect(await setRuleEnabled(db, ours, "classifier", id, false)).toBe(true);
      expect(await capture(sourceId, "Another launch")).not.toContain(category);

      expect(await setRuleEnabled(db, ours, "classifier", id, true)).toBe(true);
      expect(await capture(sourceId, "A third launch")).toContain(category);
    });
  });

  describe("the list", () => {
    it("holds the Workspace's rules, oldest first, by type", async () => {
      const workspaceOwner = unique();
      await db.insert(user).values({ id: workspaceOwner, name: "L", email: `${workspaceOwner}@example.com` });
      const [own] = await db.insert(workspace).values({ name: "Listed", ownerUserId: workspaceOwner }).returning();
      const id = own?.id ?? "";

      await saved(id, classifierYaml("first"));
      await saved(id, agentClassifierYaml("second"));
      await saved(id, extractorYaml(unique(), "third"));
      await saved(theirs, classifierYaml("someone-elses"));

      const { classifiers, extractorRules } = await listRules(db, id);
      expect(classifiers.map(({ name, kind, enabled }) => ({ name, kind, enabled }))).toEqual([
        { name: "first", kind: "deterministic", enabled: true },
        { name: "second", kind: "agent", enabled: true },
      ]);
      expect(extractorRules.map(({ name }) => name)).toEqual(["third"]);
    });

    it("lets an Agent-backed rule be saved with no model, and says there's none", async () => {
      const owner = unique();
      await db.insert(user).values({ id: owner, name: "M", email: `${owner}@example.com` });
      const [own] = await db.insert(workspace).values({ name: "Modelled", ownerUserId: owner }).returning();
      const id = own?.id ?? "";

      await saved(id, agentClassifierYaml());
      expect((await listRules(db, id)).hasModel).toBe(false);

      const model = { workspaceId: id, providerType: "anthropic", baseUrl: "https://example.com", modelName: "m" } as const;
      const [row] = await db.insert(modelConfig).values(model).returning({ id: modelConfig.id });
      expect((await listRules(db, id)).hasModel).toBe(true);

      await db.update(modelConfig).set({ archivedAt: new Date() }).where(eq(modelConfig.id, row?.id ?? ""));
      expect((await listRules(db, id)).hasModel).toBe(false);
    });
  });

  describe("another Workspace's rule", () => {
    it("is missing to every query", async () => {
      const name = unique();
      const { type, id } = await saved(theirs, classifierYaml(name));

      expect(await getRule(db, ours, type, id)).toBeUndefined();
      expect(await setRuleEnabled(db, ours, type, id, false)).toBe(false);
      expect(await removeRule(db, ours, type, id)).toBe(false);
      expect(await problems(classifierYaml(), { type, id })).toEqual([
        { path: "", message: expect.stringContaining("doesn't exist") },
      ]);

      expect(await getRule(db, theirs, type, id)).toMatchObject({ name, enabled: true });
    });

    it("is the same as an id nobody has, or one that isn't an id", async () => {
      for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
        expect(await getRule(db, ours, "classifier", id)).toBeUndefined();
        expect(await setRuleEnabled(db, ours, "classifier", id, false)).toBe(false);
        expect(await removeRule(db, ours, "classifier", id)).toBe(false);
        expect(await problems(classifierYaml(), { type: "classifier", id })).toEqual([
          { path: "", message: expect.stringContaining("doesn't exist") },
        ]);
      }
    });
  });

  describe("deleting", () => {
    it("removes the rule, and the Categories it assigned stay on their Items", async () => {
      const [feed] = await db
        .insert(source)
        .values({ workspaceId: ours, type: "rss", name: "Blog", config: { url: `https://example.com/${unique()}` }, schedule: "*/15 * * * *" })
        .returning({ id: source.id });
      const category = unique();
      const { id } = await saved(ours, `classifier: ${unique()}\nwhen: { field: title, op: exists }\nassign: [${category}]\n`);
      const [row] = await db
        .insert(item)
        .values({ workspaceId: ours, sourceId: feed?.id ?? "", externalId: unique(), title: "T", body: "", raw: {} })
        .returning({ id: item.id });
      await processItem(db, row?.id ?? "", {});

      expect(await removeRule(db, ours, "classifier", id)).toBe(true);

      expect(await db.select().from(classifier).where(eq(classifier.id, id))).toEqual([]);
      expect(await db.select().from(itemCategory).where(eq(itemCategory.itemId, row?.id ?? ""))).toMatchObject([
        { category, classifierId: null },
      ]);
    });
  });
});

function readDefinition(yaml: string) {
  const read = readDraft(yaml);
  return "draft" in read ? read.draft : undefined;
}
