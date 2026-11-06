// A Workspace's Classifiers and Extractor Rules, as the Rules screen reads and changes them. Every
// query is scoped to the Workspace, so another Workspace's rule id behaves like a missing one.
import { extractorRuleSchema, type Rule, ruleSchema } from "@watchdog/core";
import { draftFromYaml, draftToYaml } from "@watchdog/core/rules/draft";
import {
  and,
  classifier,
  type Db,
  eq,
  extractorRule,
  isNull,
  modelConfig,
  type Tx,
  workspace,
} from "@watchdog/db";
import type { RuleKind, RuleProblem, RuleType } from "./rule-draft.ts";
import { ruleNoun, unreadable } from "./rule-draft.ts";
import { isUuid } from "./uuid.ts";

const tables = { classifier, extractor: extractorRule };

/** A saved rule. A rule that isn't saved yet has no target. */
export interface RuleTarget {
  type: RuleType;
  id: string;
}

export const isRuleType = (value: unknown): value is RuleType =>
  value === "classifier" || value === "extractor";

/** The Workspace's rules by type, oldest first, which is the order they run in. */
export async function listRules(db: Db, workspaceId: string) {
  const rulesIn = (table: typeof classifier | typeof extractorRule) =>
    db
      .select({ id: table.id, name: table.name, kind: table.kind, enabled: table.enabled })
      .from(table)
      .where(eq(table.workspaceId, workspaceId))
      .orderBy(table.createdAt, table.id);
  const [classifiers, extractorRules, hasModel] = await Promise.all([
    rulesIn(classifier),
    rulesIn(extractorRule),
    hasActiveModel(db, workspaceId),
  ]);
  return { classifiers, extractorRules, hasModel };
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
  const parsed = ruleSchema.safeParse(row.definition);
  const { definition, ...rule } = row;
  return { ...rule, yaml: draftToYaml(parsed.success ? parsed.data : definition) };
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

const maxNameLength = 200;

interface ParsedRule {
  rule: Rule;
  type: RuleType;
  name: string;
  kind: RuleKind;
}

function parseRule(text: string, target: RuleTarget | null): ParsedRule | { problems: RuleProblem[] } {
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
  // An Action has its own table and Destination checks, which arrive with GitHub issue #200.
  if ("action" in rule) {
    return { problems: [{ path: "", message: "The Rules screen can't save an Action yet." }] };
  }
  const [type, name]: [RuleType, string] =
    "classifier" in rule ? ["classifier", rule.classifier] : ["extractor", rule.extractor];
  if (target !== null && target.type !== type) {
    const message = `A saved ${ruleNoun[target.type]} can't become ${type === "extractor" ? "an" : "a"} ${ruleNoun[type]}. Create a new one instead.`;
    return { problems: [{ path: "", message }] };
  }
  if (name.length > maxNameLength) {
    return { problems: [{ path: type, message: `A name can be at most ${String(maxNameLength)} characters.` }] };
  }
  if (hasUnstorableText(rule)) {
    return { problems: [{ path: "", message: "Watchdog can't store a NUL character or half a surrogate pair. Remove it." }] };
  }
  return { rule, type, name, kind: "prompt" in rule ? "agent" : "deterministic" };
}

/** What the Workspace's other rules refuse about this one: its name, and its field names. */
async function conflicts(db: Pick<Tx, "select">, workspaceId: string, parsed: ParsedRule, ownId: string | undefined) {
  const { rule, type, name } = parsed;
  const table = tables[type];
  const rows = await db
    .select({ id: table.id, name: table.name, definition: table.definition })
    .from(table)
    .where(eq(table.workspaceId, workspaceId));
  const others = rows.filter((row) => row.id !== ownId);

  const problems: RuleProblem[] = [];
  if (others.some((other) => other.name === name)) {
    problems.push({ path: type, message: `This Workspace already has a ${ruleNoun[type]} named “${name}”.` });
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
export async function problemsInDraft(db: Db, workspaceId: string, target: RuleTarget | null, text: string) {
  const parsed = parseRule(text, target);
  if ("problems" in parsed) return parsed.problems;
  return conflicts(db, workspaceId, parsed, target?.id);
}

const missing = { problems: [{ path: "", message: "This rule doesn't exist any more." }] };

/**
 * Validates the YAML with the rule model and the Workspace's other rules, and creates the rule or
 * updates the target. A later Item is the first it applies to (docs: Processing pipeline, "When
 * rules change").
 */
export async function saveRule(
  db: Db,
  workspaceId: string,
  target: RuleTarget | null,
  text: string,
): Promise<{ saved: RuleTarget } | { problems: RuleProblem[] }> {
  const parsed = parseRule(text, target);
  if ("problems" in parsed) return parsed;
  if (target !== null && !isUuid(target.id)) return missing;
  const { rule, type, name, kind } = parsed;
  const table = tables[type];

  return db.transaction(async (tx) => {
    // Two saves take turns, or each could pass the checks before the other commits. Not a key lock,
    // so a capture inserting under this Workspace isn't held up.
    await tx.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, workspaceId)).for("no key update");

    const problems = await conflicts(tx, workspaceId, parsed, target?.id);
    if (problems.length > 0) return { problems };

    const [row] =
      target === null
        ? await tx.insert(table).values({ workspaceId, name, kind, definition: rule }).returning({ id: table.id })
        : await tx
            .update(table)
            .set({ name, kind, definition: rule })
            .where(and(eq(table.workspaceId, workspaceId), eq(table.id, target.id)))
            .returning({ id: table.id });
    return row === undefined ? missing : { saved: { type, id: row.id } };
  });
}

/** Returns false when the Workspace has no such rule, which includes another Workspace's. */
export async function setRuleEnabled(db: Db, workspaceId: string, type: RuleType, id: string, enabled: boolean) {
  if (!isUuid(id)) return false;
  const table = tables[type];
  const changed = await db
    .update(table)
    .set({ enabled })
    .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)))
    .returning({ id: table.id });
  return changed.length > 0;
}

/**
 * Deletes the rule. The Categories and fields it wrote stay on their Items. Returns false when the
 * Workspace has no such rule, which includes another Workspace's.
 */
export async function removeRule(db: Db, workspaceId: string, type: RuleType, id: string) {
  if (!isUuid(id)) return false;
  const table = tables[type];
  const removed = await db
    .delete(table)
    .where(and(eq(table.workspaceId, workspaceId), eq(table.id, id)))
    .returning({ id: table.id });
  return removed.length > 0;
}
