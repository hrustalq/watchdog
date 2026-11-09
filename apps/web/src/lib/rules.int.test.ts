import { processItem, ruleSchema } from "@watchdog/core";
import { draftToYaml } from "@watchdog/core/rules/draft";
import { fakeLlm } from "@watchdog/core/testing";
import {
  action,
  actionDestination,
  classifier,
  closeDb,
  createDb,
  type Db,
  delivery,
  destination,
  digestItem,
  eq,
  extractorRule,
  item,
  itemCategory,
  itemLog,
  migrate,
  modelConfig,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { removeDestination } from "./destinations.ts";
import { blankRule, readDraft, setAt } from "./rule-draft.ts";
import {
  declaredFields,
  destinationChoices,
  getRule,
  listRules,
  problemsInDraft,
  removeRule,
  type RuleTarget,
  saveRule,
  setRuleEnabled,
} from "./rules.ts";

const unique = () => crypto.randomUUID();
const containing = (text: string): unknown => expect.stringContaining(text);
/** These Workspaces have no model, so the pipeline makes no Agent call. */
const pipelineDeps = {
  enqueueDeliveries: () => Promise.resolve(),
  agent: { fetch: fakeLlm("openai-compatible", []).fetch, encryptionKey: Buffer.alloc(32, 7) },
};

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
    const result = await saveRule(db, workspaceId, target, yaml, "hosted");
    if ("problems" in result) throw new Error(`Not saved: ${JSON.stringify(result.problems)}`);
    return result.saved;
  }

  async function problems(yaml: string, target: RuleTarget | null = null, workspaceId = ours) {
    const result = await saveRule(db, workspaceId, target, yaml, "hosted");
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
        { path: "when.all.0.value", message: containing("isn't a regular expression") },
      ]);
      expect(JSON.stringify(await problems(yaml))).not.toContain("RE2JS");
    });

    it("refuses a regex field with no capture group, beside it", async () => {
      const yaml = extractorYaml(unique()).replace("(CVE-\\d+-\\d+)", "CVE");
      expect(await problems(yaml)).toEqual([
        { path: "fields.0.regex", message: containing("no capture group") },
      ]);
    });

    it.each([
      [".price[", "isn't a CSS selector"],
      ["li:has(.price)", ":has()"],
    ])("refuses the CSS selector %s, beside it", async (selector, message) => {
      const yaml = `extractor: ${unique()}\nwhen: { field: source.type, op: is, value: website }\nfields: [{ name: price, type: string, css: "${selector}" }]\n`;
      expect(await problems(yaml)).toEqual([{ path: "fields.0.css", message: containing(message) }]);
    });

    it.each([
      ["classifier", `classifier: ${unique()}\nwhen: { field: severity, op: gte, value: 4 }\nassign: [x]\n`],
      ["extractor", `extractor: ${unique()}\nwhen: { field: severity, op: gte, value: 4 }\nfields: [{ name: a, type: string, jsonpath: "$" }]\n`],
    ])("refuses an out-of-stage field on a %s, beside the field", async (_, yaml) => {
      expect(await problems(yaml)).toEqual([
        { path: "when.field", message: containing('"severity"') },
      ]);
    });

    it("refuses a Category test on a Classifier, naming the field", async () => {
      const yaml = `classifier: ${unique()}\nwhen: { field: category, op: is, value: x }\nassign: [x]\n`;
      expect(await problems(yaml)).toEqual([{ path: "when.field", message: containing('"category"') }]);
    });

    it.each([
      ["text it can't parse", "classifier: [", /Flow sequence/],
      // The parser makes an error per unclosed bracket, and under Vitest each one is slow to build.
      ["YAML nested too deeply", "[".repeat(20_000), /./],
      ["nothing at all", "", /starts with/],
      ["a list", "- a\n", /starts with/],
    ])("refuses %s as a whole", { timeout: 60_000 }, async (_, yaml, message) => {
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
        { path, message: containing(message) },
      ]);
    });

    it("says which types a field can have", async () => {
      const yaml = extractorYaml(unique()).replace("type: string", "type: date");
      expect(await problems(yaml)).toEqual([
        { path: "fields.0.type", message: containing("string, integer") },
      ]);
    });

    it("refuses a name over 200 characters, which the unique index couldn't hold", async () => {
      expect(await problems(classifierYaml("x".repeat(201)))).toEqual([
        { path: "classifier", message: containing("200") },
      ]);
      expect(await problems(classifierYaml("x".repeat(9000)))).toHaveLength(1);
    });

    it.each([
      ["a NUL", String.raw`"a\0b"`],
      ["half a surrogate pair", String.raw`"a\uD800b"`],
    ])("refuses %s, which Postgres can't store", async (_, value) => {
      const yaml = `classifier: ${unique()}\nwhen: { field: title, op: contains, value: ${value} }\nassign: [x]\n`;
      expect(await problems(yaml)).toEqual([{ path: "", message: containing("can't store") }]);
    });

    it("stores text that only looks like an escape of those", async () => {
      const yaml = `classifier: ${unique()}\nwhen: { field: title, op: contains, value: '\\u0000 \\ud800' }\nassign: [x]\n`;
      expect(await saveRule(db, ours, null, yaml, "hosted")).toHaveProperty("saved");
    });

    it("refuses a second rule of the same type with the same name, beside the name", async () => {
      const name = unique();
      await saved(ours, classifierYaml(name));
      expect(await problems(classifierYaml(name))).toEqual([
        { path: "classifier", message: containing(name) },
      ]);
    });

    it("lets a Classifier and an Extractor Rule share a name, and another Workspace use it", async () => {
      const name = unique();
      await saved(ours, classifierYaml(name));
      expect(await saveRule(db, ours, null, extractorYaml(unique(), name), "hosted")).toHaveProperty("saved");
      expect(await saveRule(db, theirs, null, classifierYaml(name), "hosted")).toHaveProperty("saved");
    });

    it("refuses turning a saved Classifier into an Extractor Rule", async () => {
      const { type, id } = await saved(ours, classifierYaml());
      expect(await problems(extractorYaml(unique()), { type, id })).toEqual([
        { path: "", message: containing("can't become") },
      ]);
    });
  });

  describe("Actions", () => {
    async function addDestination(
      type: "telegram" | "email" | "webhook",
      { workspaceId = ours, confirmed = true, name = unique() } = {},
    ) {
      const [row] = await db
        .insert(destination)
        .values({ workspaceId, type, name, confirmedAt: confirmed ? new Date() : null })
        .returning({ id: destination.id, name: destination.name });
      if (row === undefined) throw new Error("Not added");
      return row;
    }

    const when = "when:\n  field: severity\n  op: gte\n  value: 4\n";
    const listed = (names: string[]) => `destinations:\n${names.map((name) => `  - ${name}\n`).join("")}`;
    const alertYaml = (names: string[], name = unique()) => `action: ${name}\n${when}kind: alert\n${listed(names)}`;
    const webhookYaml = (names: string[], name = unique()) => `action: ${name}\n${when}kind: webhook\n${listed(names)}`;
    const digestYaml = (names: string[], schedule: string, name = unique()) =>
      `action: ${name}\n${when}kind: digest\n${schedule}${listed(names)}`;

    it("shows an alert saved from the form identically in YAML, and an edit in YAML in what the form reads", async () => {
      const mine = await addDestination("email");
      const other = await addDestination("email");
      const fromForm = setAt(
        setAt(setAt(blankRule("action"), ["action"], unique()), ["when", "value"], "launch"),
        ["destinations"],
        [mine.name],
      );
      const yaml = draftToYaml(fromForm);

      const { type, id } = await saved(ours, yaml);
      expect(type).toBe("action");
      expect((await getRule(db, ours, type, id))?.yaml).toBe(yaml);

      await saved(ours, yaml.replace(mine.name, other.name), { type, id });
      const read = readDraft((await getRule(db, ours, type, id))?.yaml ?? "");
      expect("draft" in read && read.draft.destinations).toEqual([other.name]);
    });

    it("gives back a Digest's YAML in the model's order, though jsonb sorts its keys", async () => {
      const mine = await addDestination("email");
      const yaml = digestYaml([mine.name], 'schedule: "0 9 * * 1"\n');
      const { type, id } = await saved(ours, yaml);
      expect((await getRule(db, ours, type, id))?.yaml).toBe(yaml.replace('"0 9 * * 1"', "0 9 * * 1"));
      const { actions } = await listRules(db, ours);
      expect(actions.find((row) => row.id === id)?.schedule).toBe("0 9 * * 1");
    });

    it("stores its Destinations by id, so renaming one changes nothing, and keeps the foreign keys in step", async () => {
      const first = await addDestination("email");
      const second = await addDestination("email");
      const { type, id } = await saved(ours, alertYaml([first.name, second.name]));

      const [row] = await db.select({ definition: action.definition, kind: action.kind }).from(action).where(eq(action.id, id));
      expect(row).toMatchObject({ kind: "alert", definition: { destinations: [first.id, second.id] } });
      const pointedAt = async () => {
        const rows = await db.select().from(actionDestination).where(eq(actionDestination.actionId, id));
        return rows.map(({ destinationId }) => destinationId).sort();
      };
      expect(await pointedAt()).toEqual([first.id, second.id].sort());

      const renamed = unique();
      await db.update(destination).set({ name: renamed }).where(eq(destination.id, first.id));
      expect((await getRule(db, ours, type, id))?.yaml).toContain(`- ${renamed}\n`);

      await saved(ours, alertYaml([second.name]), { type, id });
      expect(await pointedAt()).toEqual([second.id]);
    });

    it("saves a Condition on severity, importance and an extracted field", async () => {
      const mine = await addDestination("email");
      const yaml = `action: ${unique()}\nwhen:\n  all:\n    - { field: severity, op: gte, value: 4 }\n    - { field: importance, op: lte, value: 2 }\n    - { field: fields.cve, op: exists }\nkind: alert\n${listed([mine.name])}`;
      expect(await saveRule(db, ours, null, yaml, "hosted")).toHaveProperty("saved");
    });

    it("refuses an email Destination on a webhook Action, naming it", async () => {
      const mail = await addDestination("email");
      const hook = await addDestination("webhook");
      expect(await problems(webhookYaml([hook.name, mail.name]))).toEqual([
        { path: "destinations.1", message: containing(mail.name) },
      ]);
    });

    it("refuses a name that is no Destination here, which includes another Workspace's", async () => {
      const elsewhere = await addDestination("email", { workspaceId: theirs });
      expect(await problems(alertYaml([elsewhere.name]))).toEqual([
        { path: "destinations.0", message: containing(elsewhere.name) },
      ]);
    });

    it("refuses an empty list beside the field", async () => {
      expect(await problems(`action: ${unique()}\n${when}kind: alert\ndestinations: []\n`)).toEqual([
        { path: "destinations", message: "Add at least one." },
      ]);
    });

    it.each([
      ["no schedule", "", "This is required."],
      ["a blank schedule", 'schedule: ""\n', "This can't be blank."],
      ["a schedule that isn't cron", "schedule: often\n", '"often" isn\'t a cron expression.'],
      ["a schedule under the mode's minimum", 'schedule: "*/5 * * * *"\n', "A schedule can't run more often than every 15 minutes on hosted."],
    ])("refuses a Digest with %s beside the field", async (_, schedule, message) => {
      const mine = await addDestination("email");
      expect(await problems(digestYaml([mine.name], schedule))).toEqual([{ path: "schedule", message }]);
    });

    it("lets self-hosted use a schedule hosted refuses", async () => {
      const mine = await addDestination("email");
      const yaml = digestYaml([mine.name], 'schedule: "*/5 * * * *"\n');
      expect(await saveRule(db, ours, null, yaml, "self-hosted")).toHaveProperty("saved");
    });

    it("finds what saving would refuse in a draft the page was sent back with", async () => {
      const mail = await addDestination("email");
      expect(await problemsInDraft(db, ours, null, webhookYaml([mail.name]), "hosted")).toEqual([
        { path: "destinations.0", message: containing(mail.name) },
      ]);
    });

    it("refuses a second Action with the same name, beside the name", async () => {
      const mine = await addDestination("email");
      const name = unique();
      await saved(ours, alertYaml([mine.name], name));
      expect(await problems(alertYaml([mine.name], name))).toEqual([
        { path: "action", message: containing(`an Action named “${name}”`) },
      ]);
    });

    it("refuses a saved rule changing type to or from an Action", async () => {
      const mine = await addDestination("email");
      const savedAction = await saved(ours, alertYaml([mine.name]));
      expect(await problems(classifierYaml(), savedAction)).toEqual([
        { path: "", message: "A saved Action can't become a Classifier. Create a new one instead." },
      ]);
      const classifierRule = await saved(ours, classifierYaml());
      expect(await problems(alertYaml([mine.name]), classifierRule)).toEqual([
        { path: "", message: "A saved Classifier can't become an Action. Create a new one instead." },
      ]);
    });

    it("lets an Action's kind change when its Destinations fit the new one", async () => {
      const mine = await addDestination("email");
      const { type, id } = await saved(ours, alertYaml([mine.name]));
      await saved(ours, digestYaml([mine.name], 'schedule: "0 9 * * 1"\n'), { type, id });
      expect(await getRule(db, ours, type, id)).toMatchObject({ kind: "digest" });
    });

    it("saves an Action pointing at an unconfirmed Destination, and the list says which it won't reach", async () => {
      const owner = unique();
      await db.insert(user).values({ id: owner, name: "A", email: `${owner}@example.com` });
      const [own] = await db.insert(workspace).values({ name: "Listed Actions", ownerUserId: owner }).returning();
      const id = own?.id ?? "";
      const waiting = await addDestination("email", { workspaceId: id, confirmed: false });
      const chat = await addDestination("telegram", { workspaceId: id, confirmed: false });
      const ready = await addDestination("email", { workspaceId: id });
      const hook = await addDestination("webhook", { workspaceId: id, confirmed: false });
      const name = unique();
      await saved(id, alertYaml([ready.name, waiting.name, chat.name], name));
      await saved(id, webhookYaml([hook.name]));

      const { actions } = await listRules(db, id);
      expect(actions[0]).toMatchObject({ name, kind: "alert", enabled: true, condition: "Severity is at least 4" });
      expect(actions[0]?.destinations).toEqual(
        expect.arrayContaining([
          { name: ready.name, confirmed: true },
          { name: waiting.name, confirmed: false },
          { name: chat.name, confirmed: false },
        ]),
      );
      // A webhook has no confirmation step, as in the Act stage.
      expect(actions[1]?.destinations).toEqual([{ name: hook.name, confirmed: true }]);
      expect(await destinationChoices(db, id)).toEqual(
        expect.arrayContaining([
          { name: waiting.name, type: "email", confirmed: false },
          { name: hook.name, type: "webhook", confirmed: true },
        ]),
      );
    });

    it("says so in the list when a Condition no longer parses", async () => {
      const owner = unique();
      await db.insert(user).values({ id: owner, name: "B", email: `${owner}@example.com` });
      const [own] = await db.insert(workspace).values({ name: "Broken", ownerUserId: owner }).returning();
      const id = own?.id ?? "";
      await db.insert(action).values({ workspaceId: id, name: "old", kind: "alert", definition: { action: "old", when: "x" } });
      await db.insert(action).values({
        workspaceId: id,
        name: "older",
        kind: "alert",
        definition: { action: "older", when: { field: "severity", op: "gte", value: 6 }, kind: "alert", destinations: [] },
      });
      expect((await listRules(db, id)).actions).toMatchObject([
        { name: "old", condition: null, destinations: [] },
        { name: "older", condition: null },
      ]);
    });

    it("shows a disabled Action left with no Destination in the model's order, for the user to add one", async () => {
      const mine = await addDestination("email");
      const { type, id } = await saved(ours, alertYaml([mine.name]));
      await setRuleEnabled(db, ours, type, id, false);
      expect(await removeDestination(db, ours, mine.id)).toEqual({ changed: [id] });

      const yaml = (await getRule(db, ours, type, id))?.yaml ?? "";
      expect(yaml).toMatch(/^action: .*\nwhen:[\s\S]*\nkind: alert\ndestinations: \[\]\n$/);
      const another = await addDestination("email");
      await saved(ours, yaml.replace("destinations: []", listed([another.name]).trimEnd()), { type, id });
    });

    it("doesn't fire on the next captured Item while disabled, until it's enabled again", async () => {
      const [feed] = await db
        .insert(source)
        .values({ workspaceId: ours, type: "rss", name: "Blog", config: { url: `https://example.com/${unique()}` }, schedule: "*/15 * * * *" })
        .returning({ id: source.id });
      const hook = await addDestination("webhook");
      const word = unique();
      const yaml = `action: ${unique()}\nwhen: { field: title, op: contains, value: ${word} }\nkind: webhook\n${listed([hook.name])}`;
      const { id } = await saved(ours, yaml);

      async function deliveriesAfterCapture() {
        const [row] = await db
          .insert(item)
          .values({ workspaceId: ours, sourceId: feed?.id ?? "", externalId: unique(), title: word, body: "", raw: {} })
          .returning({ id: item.id });
        await processItem(db, row?.id ?? "", pipelineDeps);
        return db.$count(delivery, eq(delivery.itemId, row?.id ?? ""));
      }

      expect(await deliveriesAfterCapture()).toBe(1);
      expect(await setRuleEnabled(db, ours, "action", id, false)).toBe(true);
      expect(await deliveriesAfterCapture()).toBe(0);
      expect(await setRuleEnabled(db, ours, "action", id, true)).toBe(true);
      expect(await deliveriesAfterCapture()).toBe(1);
    });

    it("lets only one of a save and a remove of its Destination win, leaving no dangling reference", async () => {
      const mine = await addDestination("email");
      const other = await addDestination("email");
      const { type, id } = await saved(ours, alertYaml([other.name]));
      // Either the save finds the Destination gone, or it goes first and the remove takes it out again.
      await Promise.all([
        saveRule(db, ours, { type, id }, alertYaml([mine.name, other.name]), "hosted"),
        removeDestination(db, ours, mine.id),
      ]);

      const [row] = await db.select({ definition: action.definition }).from(action).where(eq(action.id, id));
      const pointedAt = await db.select().from(actionDestination).where(eq(actionDestination.actionId, id));
      expect(JSON.stringify(row?.definition)).not.toContain(mine.id);
      expect(pointedAt.map(({ destinationId }) => destinationId)).toEqual([other.id]);
    });

    describe("what it hasn't sent yet", () => {
      async function itemIn(workspaceId = ours) {
        const [feed] = await db
          .insert(source)
          .values({ workspaceId, type: "rss", name: "Blog", config: { url: `https://example.com/${unique()}` }, schedule: "*/15 * * * *" })
          .returning({ id: source.id });
        const [row] = await db
          .insert(item)
          .values({ workspaceId, sourceId: feed?.id ?? "", externalId: unique(), title: "T", body: "", raw: {} })
          .returning({ id: item.id });
        return row?.id ?? "";
      }
      const logOf = async (itemId: string) =>
        (await db.select({ message: itemLog.message }).from(itemLog).where(eq(itemLog.itemId, itemId))).map(({ message }) => message);
      const statusesOf = async (actionId: string) =>
        (await db.select({ status: delivery.status }).from(delivery).where(eq(delivery.actionId, actionId)))
          .map(({ status }) => status)
          .sort();

      it("never sends to a Destination the edit took out, and says so in the Log", async () => {
        const kept = await addDestination("email");
        const gone = await addDestination("email");
        const name = unique();
        const { type, id } = await saved(ours, alertYaml([kept.name, gone.name], name));
        const [held, sent, stays] = [await itemIn(), await itemIn(), await itemIn()];
        await db.insert(delivery).values([
          { actionId: id, itemId: held, destinationId: gone.id, status: "held" },
          { actionId: id, itemId: sent, destinationId: gone.id, status: "sent" },
          { actionId: id, itemId: stays, destinationId: kept.id, status: "queued" },
        ]);

        await saved(ours, alertYaml([kept.name], name), { type, id });

        expect(await statusesOf(id)).toEqual(["queued", "sent"]);
        expect(await logOf(held)).toEqual([`Not sent: the Action ${name} no longer goes to ${gone.name}`]);
        expect(await logOf(sent)).toEqual([]);
        expect(await logOf(stays)).toEqual([]);
      });

      it("waits for an Act stage in progress, so what it queues to a Destination taken off is dropped too", async () => {
        const kept = await addDestination("email");
        const gone = await addDestination("email");
        const name = unique();
        const { type, id } = await saved(ours, alertYaml([kept.name, gone.name], name));
        const queued = await itemIn();
        let save: Promise<unknown> = Promise.resolve();

        await db.transaction(async (tx) => {
          await tx.select({ id: action.id }).from(action).where(eq(action.id, id)).for("key share");
          save = saveRule(db, ours, { type, id }, alertYaml([kept.name], name), "hosted");
          // Long enough for a save that doesn't wait to have finished, and so to find nothing to drop.
          await new Promise((resolve) => setTimeout(resolve, 300));
          await tx.insert(delivery).values({ actionId: id, itemId: queued, destinationId: gone.id });
        });
        await save;

        expect(await statusesOf(id)).toEqual([]);
        expect(await logOf(queued)).toEqual([`Not sent: the Action ${name} no longer goes to ${gone.name}`]);
      });

      it("waits for a send in progress, and doesn't log as unsent what it sent", async () => {
        const mine = await addDestination("email");
        const { type, id } = await saved(ours, alertYaml([mine.name]));
        const sending = await itemIn();
        const [row] = await db
          .insert(delivery)
          .values({ actionId: id, itemId: sending, destinationId: mine.id })
          .returning({ id: delivery.id });
        let removal: Promise<unknown> = Promise.resolve();

        // As `deliver` holds it through a send.
        await db.transaction(async (tx) => {
          await tx.select({ id: destination.id }).from(destination).where(eq(destination.id, mine.id)).for("no key update");
          removal = removeRule(db, ours, type, id);
          await new Promise((resolve) => setTimeout(resolve, 300));
          await tx.update(delivery).set({ status: "sent", sentAt: new Date() }).where(eq(delivery.id, row?.id ?? ""));
        });
        await removal;

        expect(await logOf(sending)).toEqual([]);
      });

      it("leaves unsent Deliveries alone when an edit keeps their Destination", async () => {
        const mine = await addDestination("email");
        const { type, id } = await saved(ours, alertYaml([mine.name]));
        const held = await itemIn();
        await db.insert(delivery).values({ actionId: id, itemId: held, destinationId: mine.id, status: "held" });
        await saved(ours, alertYaml([mine.name]), { type, id });
        expect(await statusesOf(id)).toEqual(["held"]);
      });

      it("drops what a Digest collected when it stops being one, so it can't go out later", async () => {
        const mine = await addDestination("email");
        const name = unique();
        const { type, id } = await saved(ours, digestYaml([mine.name], 'schedule: "0 9 * * 1"\n', name));
        const collected = await itemIn();
        await db.insert(digestItem).values({ actionId: id, itemId: collected });

        await saved(ours, alertYaml([mine.name], name), { type, id });

        expect(await db.select().from(digestItem).where(eq(digestItem.actionId, id))).toEqual([]);
        expect(await logOf(collected)).toEqual([`Not sent: the Action ${name} isn't a Digest any more`]);
      });

      it("says in the Log that a deleted Action's unsent alerts and collected Items never go out", async () => {
        const mine = await addDestination("email");
        const name = unique();
        const alert = await saved(ours, alertYaml([mine.name], name));
        const digestName = unique();
        const digest = await saved(ours, digestYaml([mine.name], 'schedule: "0 9 * * 1"\n', digestName));
        const [grouped, sent, collected] = [await itemIn(), await itemIn(), await itemIn()];
        await db.insert(delivery).values([
          { actionId: alert.id, itemId: grouped, destinationId: mine.id, status: "grouped" },
          { actionId: alert.id, itemId: sent, destinationId: mine.id, status: "sent" },
        ]);
        await db.insert(digestItem).values({ actionId: digest.id, itemId: collected });

        expect(await removeRule(db, ours, "action", alert.id)).toBe(true);
        expect(await removeRule(db, ours, "action", digest.id)).toBe(true);

        expect(await logOf(grouped)).toEqual([`Not sent: the Action ${name} was deleted`]);
        expect(await logOf(sent)).toEqual([]);
        expect(await logOf(collected)).toEqual([`Not sent: the Action ${digestName} was deleted`]);
      });
    });

    it("won't be enabled with no Destination, and can be once it has one", async () => {
      const mine = await addDestination("email");
      const { type, id } = await saved(ours, alertYaml([mine.name]));
      await setRuleEnabled(db, ours, type, id, false);
      await removeDestination(db, ours, mine.id);

      expect(await setRuleEnabled(db, ours, type, id, true)).toBe(false);
      expect(await getRule(db, ours, type, id)).toMatchObject({ enabled: false });
      // Turning it off is always allowed.
      expect(await setRuleEnabled(db, ours, type, id, false)).toBe(true);

      const another = await addDestination("email");
      await saved(ours, alertYaml([another.name]), { type, id });
      expect(await setRuleEnabled(db, ours, type, id, true)).toBe(true);
      expect(await getRule(db, ours, type, id)).toMatchObject({ enabled: true });
    });

    it("refuses a Rating test that could never hold, beside its value", async () => {
      const mine = await addDestination("email");
      const yaml = `action: ${unique()}\nwhen: { field: severity, op: is, value: high }\nkind: alert\n${listed([mine.name])}`;
      expect(await problems(yaml)).toEqual([{ path: "when.value", message: containing("1 to 5") }]);
    });

    it("is missing to every query from another Workspace", async () => {
      const theirsToo = await addDestination("email", { workspaceId: theirs });
      const { type, id } = await saved(theirs, alertYaml([theirsToo.name]));

      expect(await getRule(db, ours, type, id)).toBeUndefined();
      expect(await setRuleEnabled(db, ours, type, id, false)).toBe(false);
      expect(await removeRule(db, ours, type, id)).toBe(false);
      const mine = await addDestination("email");
      expect(await problems(alertYaml([mine.name]), { type, id })).toEqual([
        { path: "", message: containing("doesn't exist") },
      ]);
      expect(await getRule(db, theirs, type, id)).toMatchObject({ enabled: true });
    });

    it("goes when deleted, along with its Destination references", async () => {
      const mine = await addDestination("email");
      const { type, id } = await saved(ours, alertYaml([mine.name]));
      expect(await removeRule(db, ours, type, id)).toBe(true);
      expect(await db.select().from(actionDestination).where(eq(actionDestination.actionId, id))).toEqual([]);
    });
  });

  describe("the fields the Workspace's Extractor Rules declare", () => {
    it("lists each with its type, leaving out a rule that no longer parses", async () => {
      const owner = unique();
      await db.insert(user).values({ id: owner, name: "F", email: `${owner}@example.com` });
      const [own] = await db.insert(workspace).values({ name: "Fielded", ownerUserId: owner }).returning();
      const id = own?.id ?? "";
      await saved(id, `extractor: a\nwhen: { field: title, op: exists }\nprompt: P\nfields:\n  - { name: price, type: integer }\n  - { name: plan, type: string }\n`);
      await db.insert(extractorRule).values({ workspaceId: id, name: "old", kind: "deterministic", definition: { extractor: "old", fields: "x" } });

      expect(await declaredFields(db, id)).toEqual([
        { name: "plan", type: "string" },
        { name: "price", type: "integer" },
      ]);
    });
  });

  describe("field names across Extractor Rules", () => {
    it("refuses a field another Extractor Rule declares, beside the field", async () => {
      const field = unique();
      const other = unique();
      await saved(ours, extractorYaml(field, other));

      const reply = await problems(extractorYaml(field));

      expect(reply).toEqual([{ path: "fields.0.name", message: containing(other) }]);
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
      expect(await saveRule(db, ours, target, extractorYaml(field), "hosted")).toHaveProperty("saved");
    });

    it("frees a field name when the rule declaring it is deleted", async () => {
      const field = unique();
      const { id } = await saved(ours, extractorYaml(field));
      await removeRule(db, ours, "extractor", id);
      expect(await saveRule(db, ours, null, extractorYaml(field), "hosted")).toHaveProperty("saved");
    });

    it("doesn't count another Workspace's rules", async () => {
      const field = unique();
      await saved(theirs, extractorYaml(field));
      expect(await saveRule(db, ours, null, extractorYaml(field), "hosted")).toHaveProperty("saved");
    });

    it("lets only one of two concurrent saves declare a field", async () => {
      const field = unique();
      const results = await Promise.all([
        saveRule(db, ours, null, extractorYaml(field), "hosted"),
        saveRule(db, ours, null, extractorYaml(field), "hosted"),
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
      expect(await saveRule(db, ours, null, extractorYaml(unique()), "hosted")).toHaveProperty("saved");
    });
  });

  describe("checking a draft the page was sent back with", () => {
    it("finds what saving would refuse, without saving", async () => {
      const field = unique();
      await saved(ours, extractorYaml(field));
      const name = unique();
      expect(await problemsInDraft(db, ours, null, extractorYaml(field, name), "hosted")).toEqual([
        { path: "fields.0.name", message: containing(field) },
      ]);
      expect((await listRules(db, ours)).extractorRules.map((rule) => rule.name)).not.toContain(name);
    });

    it("finds nothing in a draft that would save", async () => {
      expect(await problemsInDraft(db, ours, null, classifierYaml(), "hosted")).toEqual([]);
    });

    it("doesn't count an edited rule as its own conflict", async () => {
      const field = unique();
      const target = await saved(ours, extractorYaml(field));
      expect(await problemsInDraft(db, ours, target, extractorYaml(field), "hosted")).toEqual([]);
    });
  });

  describe("disabling", () => {
    async function capture(sourceId: string, title: string) {
      const [row] = await db
        .insert(item)
        .values({ workspaceId: ours, sourceId, externalId: unique(), title, body: "", raw: {} })
        .returning({ id: item.id });
      if (row === undefined) throw new Error("Not captured");
      await processItem(db, row.id, pipelineDeps);
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
        { path: "", message: containing("doesn't exist") },
      ]);

      expect(await getRule(db, theirs, type, id)).toMatchObject({ name, enabled: true });
    });

    it("is the same as an id nobody has, or one that isn't an id", async () => {
      for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
        expect(await getRule(db, ours, "classifier", id)).toBeUndefined();
        expect(await setRuleEnabled(db, ours, "classifier", id, false)).toBe(false);
        expect(await removeRule(db, ours, "classifier", id)).toBe(false);
        expect(await problems(classifierYaml(), { type: "classifier", id })).toEqual([
          { path: "", message: containing("doesn't exist") },
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
      await processItem(db, row?.id ?? "", pipelineDeps);

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
