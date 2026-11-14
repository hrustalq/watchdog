// A Workspace's Classifiers, Extractor Rules and Actions, as the Rules screen reads and changes them.
// Every query is scoped to the Workspace, so another Workspace's rule id behaves like a missing one.
import {
  type Action,
  actionSchema,
  classifierSchema,
  conditionToWords,
  type Config,
  extractorRuleSchema,
  jsonPathFansOut,
  type Rule,
  ruleInstructions,
  ruleSchema,
} from "@watchdog/core";
import { draftFromYaml, draftToYaml } from "@watchdog/core/rules/draft";
import {
  action,
  actionDestination,
  and,
  classifier,
  type Db,
  desc,
  delivery,
  destination,
  digestItem,
  eq,
  extractorRule,
  inArray,
  isNull,
  item,
  itemCategory,
  itemLog,
  modelConfig,
  type SQL,
  type Tx,
  workspace,
} from "@watchdog/db";
import { actionProblems } from "./actions.ts";
import type { ActionKind, DeclaredField, DestinationChoice, RuleKind, RuleProblem, RuleType } from "./rule-draft.ts";
import { aRule, inActionOrder, isMap, ruleNoun, unreadable } from "./rule-draft.ts";
import { ruleSummary } from "./rule-summary.ts";
import { isUuid } from "./uuid.ts";

type Mode = Config["mode"];

const tables = { classifier, extractor: extractorRule, action };

/** A saved rule. A rule that isn't saved yet has no target. */
export interface RuleTarget {
  type: RuleType;
  id: string;
}

export const isRuleType = (value: unknown): value is RuleType =>
  value === "classifier" || value === "extractor" || value === "action";

/** The Workspace's rules by type, oldest first, which is the order they run in. */
export async function listRules(db: Db, workspaceId: string) {
  // A rule's definition is read here and parsed once, so its row can say what it does. A definition
  // that no longer parses becomes `unreadable` rather than reaching the page as raw jsonb.
  const rulesIn = async (table: typeof classifier | typeof extractorRule) =>
    (
      await db
        .select({
          id: table.id,
          name: table.name,
          kind: table.kind,
          enabled: table.enabled,
          definition: table.definition,
        })
        .from(table)
        .where(eq(table.workspaceId, workspaceId))
        .orderBy(table.createdAt, table.id)
    ).map(({ definition, ...row }) => ({ ...row, summary: ruleSummary(definition) }));

  const [classifiers, extractorRules, actions, hasModel] = await Promise.all([
    rulesIn(classifier),
    rulesIn(extractorRule),
    listActions(db, workspaceId),
    hasActiveModel(db, workspaceId),
  ]);
  return { classifiers, extractorRules, actions, hasModel };
}

// A webhook has no confirmation step, so only its type says this and not `confirmed_at`, as in the Act stage.
const isConfirmed = ({ type, confirmedAt }: { type: DestinationChoice["type"]; confirmedAt: Date | null }) =>
  type === "webhook" || confirmedAt !== null;

/** The Workspace's Actions, oldest first, with what each does in words. `condition` is null when it no longer parses, and the Act stage skips it. */
async function listActions(db: Db, workspaceId: string) {
  const rows = await db.query.action.findMany({
    where: eq(action.workspaceId, workspaceId),
    columns: { id: true, name: true, kind: true, enabled: true, definition: true },
    with: { actionDestinations: { with: { destination: { columns: { name: true, type: true, confirmedAt: true } } } } },
    orderBy: [action.createdAt, action.id],
  });
  return rows.map(({ definition, actionDestinations, ...row }) => {
    // Whatever its Destinations, because a disabled Action left with none still has a Condition to show.
    const parsed = actionSchema.safeParse(isMap(definition) ? { ...definition, destinations: ["any"] } : definition);
    return {
      ...row,
      condition: parsed.success ? conditionToWords(parsed.data.when) : null,
      schedule: isMap(definition) && typeof definition.schedule === "string" ? definition.schedule : null,
      destinations: actionDestinations.map(({ destination: target }) => ({ name: target.name, confirmed: isConfirmed(target) })),
    };
  });
}

/** The Workspace's Destinations, newest first as on the Destinations screen. */
function destinationsIn(reader: Pick<Tx, "select">, workspaceId: string) {
  return reader
    .select({ id: destination.id, name: destination.name, type: destination.type, confirmedAt: destination.confirmedAt })
    .from(destination)
    .where(eq(destination.workspaceId, workspaceId))
    .orderBy(desc(destination.createdAt), desc(destination.id));
}

/** What the Action editor offers. */
export async function destinationChoices(db: Db, workspaceId: string): Promise<DestinationChoice[]> {
  const rows = await destinationsIn(db, workspaceId);
  return rows.map((row) => ({ name: row.name, type: row.type, confirmed: isConfirmed(row) }));
}

/** The fields the Workspace's Extractor Rules declare, by name. A rule that no longer parses declares nothing. */
export async function declaredFields(db: Db, workspaceId: string): Promise<DeclaredField[]> {
  const rows = await db
    .select({ definition: extractorRule.definition })
    .from(extractorRule)
    .where(eq(extractorRule.workspaceId, workspaceId));
  return rows
    .flatMap(({ definition }) => {
      const parsed = extractorRuleSchema.safeParse(definition);
      return parsed.success ? parsed.data.fields.map(({ name, type }) => ({ name, type })) : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** How many known Categories the editor offers: more than any Workspace uses, and one list to read. */
export const maxKnownCategories = 50;

/**
 * The Categories the Workspace knows: the ones its Items carry, and the ones its Classifiers declare,
 * so a new Classifier's Categories count before any Item has them. `item_category` has no Workspace
 * column, so the Items' go through `item`. A Category is open-ended, so this is what the editor
 * suggests, never what a rule may say.
 */
export async function knownCategories(db: Db, workspaceId: string): Promise<string[]> {
  const [onItems, classifiers] = await Promise.all([
    db
      .selectDistinct({ category: itemCategory.category })
      .from(itemCategory)
      .innerJoin(item, eq(item.id, itemCategory.itemId))
      .where(eq(item.workspaceId, workspaceId))
      .orderBy(itemCategory.category)
      .limit(maxKnownCategories),
    db.select({ definition: classifier.definition }).from(classifier).where(eq(classifier.workspaceId, workspaceId)),
  ]);
  // A Classifier that no longer parses runs nothing, so it declares nothing.
  const declared = classifiers.flatMap(({ definition }) => {
    const parsed = classifierSchema.safeParse(definition);
    if (!parsed.success) return [];
    return "assign" in parsed.data ? parsed.data.assign : parsed.data.categories;
  });
  return [...new Set([...onItems.map(({ category }) => category), ...declared])]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, maxKnownCategories);
}

/** Whether the Workspace has a model. Without one, Agent-backed rules can't run. */
export async function hasActiveModel(db: Db, workspaceId: string) {
  const models = await db.$count(
    modelConfig,
    and(eq(modelConfig.workspaceId, workspaceId), isNull(modelConfig.archivedAt)),
  );
  return models > 0;
}

/** One of the Workspace's rules with its YAML, or undefined. */
export async function getRule(db: Db, workspaceId: string, type: RuleType, id: string) {
  if (!isUuid(id)) return undefined;
  const table = tables[type];
  const [row] = await db
    .select({ name: table.name, kind: table.kind, enabled: table.enabled, definition: table.definition })
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)));
  if (row === undefined) return undefined;
  // jsonb sorts its keys, and parsing puts them back in the model's order. A definition that no
  // longer parses is shown as it is, for the user to fix.
  const { definition, ...rule } = row;
  const shown = type === "action" ? await withDestinationNames(db, workspaceId, definition) : definition;
  const parsed = ruleSchema.safeParse(shown);
  if (parsed.success) return { ...rule, yaml: draftToYaml(parsed.data) };
  return { ...rule, yaml: draftToYaml(type === "action" && isMap(shown) ? inActionOrder(shown) : shown) };
}

/** A stored Action as the YAML shows it: Destinations by name, and an id with no Destination left as it is. */
async function withDestinationNames(db: Db, workspaceId: string, definition: unknown) {
  if (!isMap(definition) || !Array.isArray(definition.destinations)) return definition;
  const names = new Map<unknown, string>((await destinationsIn(db, workspaceId)).map(({ id, name }) => [id, name]));
  return { ...definition, destinations: definition.destinations.map((id: unknown) => names.get(id) ?? id) };
}

type RuleIssue = NonNullable<ReturnType<typeof ruleSchema.safeParse>["error"]>["issues"][number];

const typeWords: Partial<Record<string, string>> = {
  string: "text",
  number: "a number",
  array: "a list",
  object: "a mapping",
};

/** An issue in words a user can act on. The rule model's own messages already are. */
function issueMessage(issue: RuleIssue) {
  switch (issue.code) {
    case "invalid_type":
      return issue.message.endsWith("received undefined")
        ? "This is required."
        : `This has to be ${typeWords[issue.expected] ?? issue.expected}.`;
    case "too_small":
      return issue.origin === "array" ? "Add at least one." : "This can't be blank.";
    case "too_big":
      return `This can have at most ${String(issue.maximum)}.`;
    case "unrecognized_keys":
      return `A rule has no ${issue.keys.map((key) => `"${key}"`).join(" or ")} here. Remove it.`;
    case "invalid_value":
      return `Use one of ${issue.values.join(", ")}.`;
    case "custom":
    case "invalid_element":
    case "invalid_format":
    case "invalid_key":
    case "invalid_union":
    case "not_multiple_of":
      return issue.message;
  }
}

/** Postgres text and jsonb refuse a NUL and half a surrogate pair, which YAML can spell. */
function hasUnstorableText(rule: Rule) {
  let found = false;
  JSON.stringify(rule, (_key, value: unknown) => {
    if (typeof value === "string" && (value.includes("\0") || !value.isWellFormed())) found = true;
    return value;
  });
  return found;
}

/**
 * A rule arrives as YAML in one Server Action field, and the parser runs on the web process, so the
 * text is refused before it's read. 64 KB leaves room for every limit the model states with YAML's
 * own keys and indentation on top: a 4,000-character prompt, and 50 Categories and 50 fields each
 * named in up to 200 characters, stay well under it. Parsing 200 KB took 235 ms in plain Node, so
 * this bounds one save at about a quarter of that.
 */
export const maxRuleYaml = 65_536;

interface ParsedRule {
  rule: Rule;
  type: RuleType;
  name: string;
  kind: RuleKind | ActionKind;
}

const typeAndName = (rule: Rule): [RuleType, string] => {
  if ("classifier" in rule) return ["classifier", rule.classifier];
  return "extractor" in rule ? ["extractor", rule.extractor] : ["action", rule.action];
};

function parseRule(text: string, target: RuleTarget | null): ParsedRule | { problems: RuleProblem[] } {
  // Before the parser reads it: the schemas bound what a rule holds, and this bounds what reaching
  // them costs. The message names the limit, because nothing in the text says how long it is.
  if (text.length > maxRuleYaml) {
    return {
      problems: [
        {
          path: "",
          message: `A rule's YAML can be at most ${maxRuleYaml.toLocaleString("en")} characters, which is 64 KB. This one is ${text.length.toLocaleString("en")}.`,
        },
      ],
    };
  }
  let value: unknown;
  try {
    value = draftFromYaml(text);
  } catch (error) {
    return { problems: [{ path: "", message: unreadable(error) }] };
  }
  const parsed = ruleSchema.safeParse(value);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issueMessage(issue),
      })),
    };
  }
  const rule = parsed.data;
  const [type, name] = typeAndName(rule);
  if (target !== null && target.type !== type) {
    const message = `A saved ${ruleNoun[target.type]} can't become ${aRule(type)}. Create a new one instead.`;
    return { problems: [{ path: "", message }] };
  }
  if (hasUnstorableText(rule)) {
    return { problems: [{ path: "", message: "Watchdog can't store a NUL character or half a surrogate pair. Remove it." }] };
  }
  if ("action" in rule) return { rule, type, name, kind: rule.kind };
  return { rule, type, name, kind: "prompt" in rule ? "agent" : "deterministic" };
}

/**
 * What the Workspace's other rules refuse about this one: its name, and an Extractor Rule's field
 * names.
 */
async function conflicts(
  db: Pick<Tx, "select">,
  workspaceId: string,
  parsed: ParsedRule,
  ownId: string | undefined,
) {
  const { rule, type, name } = parsed;
  const table = tables[type];
  const rows = await db
    .select({ id: table.id, name: table.name, definition: table.definition })
    .from(table)
    .where(eq(table.workspaceId, workspaceId));
  const others = rows.filter((row) => row.id !== ownId);

  const problems: RuleProblem[] = [];
  if (others.some((other) => other.name === name)) {
    problems.push({ path: type, message: `This Workspace already has ${aRule(type)} named “${name}”.` });
  }
  if (!("extractor" in rule)) return problems;

  // A rule that no longer parses doesn't run, so it declares nothing.
  const declared = others.map(({ name: ruleName, definition }) => {
    const other = extractorRuleSchema.safeParse(definition);
    return { name: ruleName, fields: new Set(other.success ? other.data.fields.map((field) => field.name) : []) };
  });
  for (const [index, field] of rule.fields.entries()) {
    const declaring = declared.find((other) => other.fields.has(field.name));
    if (declaring !== undefined) {
      problems.push({
        path: `fields.${String(index)}.name`,
        message: `The Extractor Rule “${declaring.name}” already declares the field “${field.name}”. Rename it here, so fields.${field.name} means one thing.`,
      });
    }
  }
  return problems;
}

/** Why this draft wouldn't save, without saving it. Empty when it would. */
export async function problemsInDraft(
  db: Db,
  workspaceId: string,
  target: RuleTarget | null,
  text: string,
  mode: Mode,
) {
  const parsed = parseRule(text, target);
  if ("problems" in parsed) return parsed.problems;
  const problems = await conflicts(db, workspaceId, parsed, target?.id);
  if (!("action" in parsed.rule)) return problems;
  return [...problems, ...actionProblems(parsed.rule, await destinationsIn(db, workspaceId), mode)];
}

const missing = { problems: [{ path: "", message: "This rule doesn't exist any more." }] };

/**
 * end on "Held until". It takes their Destinations' rows first, as `removeDestination` does, because a
 * send holds its Destination's row: that waits for an email or Telegram send in progress, whose Delivery
 * then no longer counts as unsent. A webhook call holds no lock, so one in flight can still reach its
 * receiver. Not the Deliveries' own rows, or deleting an Item would wait for a send to it.
 */
async function dropUnsent(tx: Tx, which: SQL | undefined, message: string) {
  const unsentNow = () =>
    tx
      .select({ id: delivery.id, itemId: delivery.itemId, actionId: delivery.actionId, destinationId: delivery.destinationId })
      .from(delivery)
      .where(and(which, inArray(delivery.status, ["queued", "held", "grouped"])));
  const waiting = await unsentNow();
  if (waiting.length === 0) return;
  // In id order, so two of these can't deadlock.
  await tx
    .select({ id: destination.id })
    .from(destination)
    .where(inArray(destination.id, waiting.map(({ destinationId }) => destinationId)))
    .orderBy(destination.id)
    .for("update");

  const unsent = await unsentNow();
  if (unsent.length === 0) return;
  await tx.insert(itemLog).values(
    unsent.map(({ itemId, actionId, destinationId }) => ({
      itemId,
      stage: "act" as const,
      message,
      data: { actionId, destinationId },
    })),
  );
  await tx.delete(delivery).where(inArray(delivery.id, unsent.map(({ id }) => id)));
}

/** As `dropUnsent`, for the Items a Digest has collected and not sent. A Destination has its own rows. */
async function dropCollected(tx: Tx, which: SQL | undefined, message: string, data: Record<string, unknown>) {
  const collected = await tx.delete(digestItem).where(which).returning({ itemId: digestItem.itemId });
  if (collected.length === 0) return;
  await tx.insert(itemLog).values(
    [...new Set(collected.map(({ itemId }) => itemId))].map((itemId) => ({
      itemId,
      stage: "act" as const,
      message,
      data,
    })),
  );
}

type HeldDestination = Awaited<ReturnType<typeof destinationsIn>>[number];

/**
 * Stores an Action with its Destinations by id (the YAML shows their names, and renaming one changes
 * nothing here), and points the foreign keys at the same set. The checks have passed on `held`, so
 * every name has an id. What it was still waiting to send where it no longer goes never goes out.
 */
async function storeAction(
  tx: Tx,
  workspaceId: string,
  target: RuleTarget | null,
  rule: Action,
  held: HeldDestination[],
) {
  const ids = new Map(held.map(({ id, name }) => [name, id]));
  const destinationIds = rule.destinations.flatMap((name) => ids.get(name) ?? []);
  // Waits for an Act stage that read this Action as it was, so what it queues is here to be dropped below.
  if (target !== null) {
    await tx.select({ id: action.id }).from(action).where(eq(action.id, target.id)).for("update");
  }
  const values = { name: rule.action, kind: rule.kind, definition: { ...rule, destinations: destinationIds } };
  const [row] =
    target === null
      ? await tx.insert(action).values({ workspaceId, ...values }).returning({ id: action.id })
      : await tx
          .update(action)
          .set(values)
          .where(and(eq(action.workspaceId, workspaceId), eq(action.id, target.id)))
          .returning({ id: action.id });
  if (row === undefined) return undefined;

  const dropped = await tx.delete(actionDestination).where(eq(actionDestination.actionId, row.id)).returning();
  await tx.insert(actionDestination).values(destinationIds.map((destinationId) => ({ actionId: row.id, destinationId })));
  for (const { destinationId } of dropped) {
    if (destinationIds.includes(destinationId)) continue;
    const name = held.find(({ id }) => id === destinationId)?.name ?? destinationId;
    const message = `Not sent: the Action ${rule.action} no longer goes to ${name}`;
    await dropUnsent(tx, and(eq(delivery.actionId, row.id), eq(delivery.destinationId, destinationId)), message);
    // A Digest collects per Destination, so what waited for this one goes with it.
    await dropCollected(
      tx,
      and(eq(digestItem.actionId, row.id), eq(digestItem.destinationId, destinationId)),
      message,
      { actionId: row.id, destinationId, destination: name },
    );
  }
  if (rule.kind !== "digest") {
    await dropCollected(tx, eq(digestItem.actionId, row.id), `Not sent: the Action ${rule.action} isn't a Digest any more`, { actionId: row.id });
  }
  return row;
}

/** Stores a Classifier or an Extractor Rule. */
async function storeRule(
  tx: Tx,
  workspaceId: string,
  target: RuleTarget | null,
  { rule, name, kind }: { rule: Rule; name: string; kind: RuleKind },
  table: typeof classifier | typeof extractorRule,
) {
  const [row] =
    target === null
      ? await tx.insert(table).values({ workspaceId, name, kind, definition: rule }).returning({ id: table.id })
      : await tx
          .update(table)
          .set({ name, kind, definition: rule })
          .where(and(eq(table.workspaceId, workspaceId), eq(table.id, target.id)))
          .returning({ id: table.id });
  return row;
}

/**
 * What a Workspace's enabled rules cost: the regex instructions they run, how many there are, and how
 * many of their fields read a JSONPath that can fan out.
 */
interface RuleCost {
  instructions: number;
  rules: number;
  jsonPathFields: number;
}

const noCost: RuleCost = { instructions: 0, rules: 0, jsonPathFields: 0 };

/**
 * How many of a rule's fields read their value with a path that can fan out. Only those can cost the
 * worker per node of the Item; a path of names and indexes reads a fixed route (GitHub issue #111).
 */
function fanOutFields(rule: Rule): number {
  if (!("extractor" in rule)) return 0;
  let fields = 0;
  for (const field of rule.fields) {
    if ("jsonpath" in field && jsonPathFansOut(field.jsonpath)) fields += 1;
  }
  return fields;
}

/** A stored definition's cost. One that no longer parses runs nothing, so it costs nothing. */
function costOf(definition: unknown): RuleCost {
  const parsed = ruleSchema.safeParse(definition);
  return parsed.success
    ? { instructions: ruleInstructions(parsed.data), rules: 1, jsonPathFields: fanOutFields(parsed.data) }
    : noCost;
}

/**
 * What the Workspace's enabled rules cost, without `skip`. Read inside the writer's transaction and
 * under its lock, so two writes can't both pass a limit check.
 */
async function enabledCost(
  reader: Pick<Tx, "select">,
  workspaceId: string,
  skip: RuleTarget | null,
): Promise<RuleCost> {
  // One at a time: a transaction holds a single connection, and pg deprecates overlapping queries on
  // one client.
  const classifiers = await reader
    .select({ id: classifier.id, definition: classifier.definition })
    .from(classifier)
    .where(and(eq(classifier.workspaceId, workspaceId), eq(classifier.enabled, true)));
  const extractors = await reader
    .select({ id: extractorRule.id, definition: extractorRule.definition })
    .from(extractorRule)
    .where(and(eq(extractorRule.workspaceId, workspaceId), eq(extractorRule.enabled, true)));
  const actions = await reader
    .select({ id: action.id, definition: action.definition })
    .from(action)
    .where(and(eq(action.workspaceId, workspaceId), eq(action.enabled, true)));
  const counted = (rows: { id: string; definition: unknown }[], type: RuleType) =>
    rows
      .filter((row) => skip === null || skip.type !== type || skip.id !== row.id)
      .map((row) => costOf(row.definition));
  return [...counted(classifiers, "classifier"), ...counted(extractors, "extractor"), ...counted(actions, "action")]
    .reduce(
      (total, cost) => ({
        instructions: total.instructions + cost.instructions,
        rules: total.rules + cost.rules,
        jsonPathFields: total.jsonPathFields + cost.jsonPathFields,
      }),
      noCost,
    );
}

/**
 * Why the Workspace would be over a hosted plan's rule limits once this rule is counted, or
 * undefined. The message names the limit and the usage, because neither is visible on the rule.
 */
function overRuleLimits(limits: Config["ruleLimits"], cost: RuleCost): RuleProblem | undefined {
  if (limits === undefined) return undefined;
  if (cost.rules > limits.rules) {
    return {
      path: "",
      message: `The hosted plan allows a Workspace ${limits.rules.toLocaleString("en")} rules, counting Classifiers, Extractor Rules and Actions. This would make ${cost.rules.toLocaleString("en")}. Disable or delete one to make room.`,
    };
  }
  if (cost.instructions > limits.instructions) {
    return {
      path: "",
      message: `The hosted plan allows a Workspace's rules ${limits.instructions.toLocaleString("en")} regex instructions in total, and this would use ${cost.instructions.toLocaleString("en")}. Disable a rule, or make one's regexes simpler, to make room.`,
    };
  }
  if (cost.jsonPathFields > limits.jsonPathFields) {
    return {
      path: "",
      message: `The hosted plan allows a Workspace's rules ${limits.jsonPathFields.toLocaleString("en")} JSONPath fields that can fan out, counting a path with "..", "*", a selector list or a filter, and this would use ${cost.jsonPathFields.toLocaleString("en")}. Disable a rule, or read a field by name and index, to make room.`,
    };
  }
  return undefined;
}

/** Whether a rule is enabled once saved: a new one is, and an edit keeps the flag it has. */
async function enabledAfterSave(
  reader: Pick<Tx, "select">,
  workspaceId: string,
  target: RuleTarget | null,
): Promise<boolean | undefined> {
  if (target === null) return true;
  const table = tables[target.type];
  const [row] = await reader
    .select({ enabled: table.enabled })
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), eq(table.id, target.id)));
  return row?.enabled;
}

/**
 * Validates the YAML with the rule model and the Workspace's other rules, and creates the rule or
 * updates the target. A later Item is the first it applies to (docs: Processing pipeline, "When
 * rules change"). A hosted plan's rule limits are checked in the same transaction, under the
 * Workspace's lock, and `limits` is undefined on a self-hosted install, which sets none.
 */
export async function saveRule(
  db: Db,
  workspaceId: string,
  target: RuleTarget | null,
  text: string,
  mode: Mode,
  limits: Config["ruleLimits"],
): Promise<{ saved: RuleTarget } | { problems: RuleProblem[] }> {
  const parsed = parseRule(text, target);
  if ("problems" in parsed) return parsed;
  if (target !== null && !isUuid(target.id)) return missing;
  const { rule, type, name, kind } = parsed;

  return db.transaction(async (tx) => {
    // Two saves take turns, or each could pass the checks before the other commits. Not a key lock,
    // so a capture inserting under this Workspace isn't held up.
    await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("no key update");

    const enabled = await enabledAfterSave(tx, workspaceId, target);
    if (enabled === undefined) return missing;
    const others = await conflicts(tx, workspaceId, parsed, target?.id);
    // Held until this commits, as a send holds them, so one can't be removed between the check and the
    // foreign key. Before the Action's row, in the order `removeDestination` takes them, so the two
    // can't deadlock.
    const held = "action" in rule ? await destinationsIn(tx, workspaceId).for("key share") : [];
    const problems = "action" in rule ? [...others, ...actionProblems(rule, held, mode)] : others;
    if (problems.length > 0) return { problems };

    // A disabled rule costs the worker nothing, which is why disabling one frees its share.
    const used = await enabledCost(tx, workspaceId, target);
    const own = enabled
      ? { instructions: ruleInstructions(rule), rules: 1, jsonPathFields: fanOutFields(rule) }
      : noCost;
    const refusal = overRuleLimits(limits, {
      instructions: used.instructions + own.instructions,
      rules: used.rules + own.rules,
      jsonPathFields: used.jsonPathFields + own.jsonPathFields,
    });
    if (refusal !== undefined) return { problems: [refusal] };

    const row =
      "action" in rule
        ? await storeAction(tx, workspaceId, target, rule, held)
        : await storeRule(
            tx,
            workspaceId,
            target,
            { rule, name, kind: kind === "agent" ? "agent" : "deterministic" },
            type === "classifier" ? classifier : extractorRule,
          );
    return row === undefined ? missing : { saved: { type, id: row.id } };
  });
}

/**
 * Whether an Action has a Destination to enable it with (docs: Actions and delivery, "Deleting a
 * Destination"). Holds the Action, because `removeDestination` counts enabled Actions while it holds
 * them, so one can't be enabled just as it loses its last Destination.
 */
async function canEnableAction(tx: Tx, workspaceId: string, id: string) {
  const [row] = await tx
    .select({ id: action.id })
    .from(action)
    .where(and(eq(action.workspaceId, workspaceId), eq(action.id, id)))
    .for("no key update");
  return row !== undefined && (await tx.$count(actionDestination, eq(actionDestination.actionId, id))) > 0;
}

/** What enabling or disabling a rule did. */
export interface EnableResult {
  /** Whether it now has the flag that was asked for. */
  enabled: boolean;
  /** Why a hosted plan's rule limit refused the enable. */
  problems: RuleProblem[];
}

/**
 * Enables or disables the rule. An enable is checked against a hosted plan's rule limits in the
 * Workspace's transaction, as a save is, and returns why it was refused. Disabling always frees the
 * rule's share.
 */
export async function setRuleEnabled(
  db: Db,
  workspaceId: string,
  type: RuleType,
  id: string,
  enabled: boolean,
  limits: Config["ruleLimits"],
): Promise<EnableResult> {
  const refused = (problems: RuleProblem[] = []): EnableResult => ({ enabled: false, problems });
  if (!isUuid(id)) return refused();
  const table = tables[type];
  // Disabling costs nothing, so it needs neither the limit check nor the lock behind a save.
  if (!enabled) {
    const changed = await db
      .update(table)
      .set({ enabled })
      .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)))
      .returning({ id: table.id });
    return { enabled: changed.length > 0, problems: [] };
  }
  return db.transaction(async (tx) => {
    // Two enables, or an enable and a save, take turns, so each reads the other's committed usage.
    await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("no key update");
    const [row] = await tx
      .select({ definition: table.definition })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)))
      .for("no key update");
    if (row === undefined) return refused();
    if (type === "action" && !(await canEnableAction(tx, workspaceId, id))) return refused();
    // The rule is disabled now, so `used` can't include it; its own cost is added here.
    const used = await enabledCost(tx, workspaceId, { type, id });
    const own = costOf(row.definition);
    const refusal = overRuleLimits(limits, {
      instructions: used.instructions + own.instructions,
      rules: used.rules + own.rules,
      jsonPathFields: used.jsonPathFields + own.jsonPathFields,
    });
    if (refusal !== undefined) return refused([refusal]);
    await tx
      .update(table)
      .set({ enabled: true })
      .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)));
    return { enabled: true, problems: [] };
  });
}

/**
 * Deletes the rule. The Categories and fields it wrote stay on their Items, and an Action's Log rows on
 * theirs, with one more for whatever it hadn't sent yet. Returns false when the Workspace has no such
 * rule, which includes another Workspace's.
 */
export async function removeRule(db: Db, workspaceId: string, type: RuleType, id: string) {
  if (!isUuid(id)) return false;
  const table = tables[type];
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ name: table.name })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)))
      .for("update");
    if (row === undefined) return false;
    if (type === "action") {
      const message = `Not sent: the Action ${row.name} was deleted`;
      await dropUnsent(tx, eq(delivery.actionId, id), message);
      await dropCollected(tx, eq(digestItem.actionId, id), message, { actionId: id });
    }
    await tx.delete(table).where(eq(table.id, id));
    return true;
  });
}
