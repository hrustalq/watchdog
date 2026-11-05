// The extract-and-rate stage (docs: Processing pipeline, "Stages"; Agent and LLM integration, "Calls
// per Item").
import { and, type Db, eq, extractorRule, isNull, item, itemLog, type Tx } from "@watchdog/db";
import { type AgentFailure, callAgent, storableMessage, storableText } from "../agent/call-agent.ts";
import { recentCorrections } from "../agent/corrections.ts";
import { loadProfile } from "../agent/profile.ts";
import { buildAgentPrompt, type PromptContext } from "../agent/prompt.ts";
import { fieldKey, ratingSchema, ratingTask } from "../agent/rating.ts";
import { type ConditionItem, evaluateCondition } from "../rules/condition.ts";
import { type AgentExtractorRule, agentExtractorRuleSchema } from "../rules/schema.ts";
import { type AgentDeps, modelFor } from "./classify.ts";
import { categoriesOf, logSkippedRule, storeExtraction, toExtraction } from "./extract.ts";
import { logOnce, rulesFor } from "./rules-for-item.ts";

interface ParsedRule {
  id: string;
  name: string;
  definition: AgentExtractorRule;
}

type Answer = Record<string, unknown> & {
  summary: string;
  reasoning: string;
  severity: number;
  importance: number;
};

/** The enabled Agent-backed Extractor Rules whose Condition the Item meets, oldest first. */
async function applyingRules(db: Db, target: ConditionItem & { id: string }) {
  const saved = await rulesFor(db, extractorRule, target.id, "agent");
  if (saved.length === 0) return [];
  const log = await logOnce(db, target.id, "extract");
  const categories = await categoriesOf(db, target.id);

  const rules: ParsedRule[] = [];
  for (const rule of saved) {
    const parsed = agentExtractorRuleSchema.safeParse(rule.definition);
    if (!parsed.success) await logSkippedRule(log, rule, parsed.error);
    else if (evaluateCondition(parsed.data.when, { ...target, categories })) {
      rules.push({ id: rule.id, name: rule.name, definition: parsed.data });
    }
  }
  return rules;
}

/** Commits `work` with `processed_at`, unless the Item is gone or another run already finished it. */
async function finish(db: Db, itemId: string, now: () => Date, work: (tx: Tx) => Promise<void>) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ processedAt: item.processedAt })
      .from(item)
      .where(eq(item.id, itemId))
      .for("update");
    if (row?.processedAt !== null) return;
    await work(tx);
    await tx.update(item).set({ processedAt: now() }).where(eq(item.id, itemId));
  });
}

/** A provider's answer can hold what Postgres refuses, and asking again wouldn't change that. */
function cleanValue(value: unknown): unknown {
  if (typeof value === "string") return storableText(value);
  return Array.isArray(value) ? value.map(cleanValue) : value;
}

/** What a field found, the shape `toExtraction` reads. Null, blank or empty means the Item has none. */
function foundIn(answer: Answer, name: string): unknown[] {
  const value = cleanValue(answer[fieldKey(name)]);
  return value === null || (typeof value === "string" && value.trim() === "") ? [] : [value];
}

async function storeAnswer(tx: Tx, itemId: string, rules: ParsedRule[], answer: Answer, now: () => Date) {
  const { severity, importance } = answer;
  const reasoning = storableText(answer.reasoning);
  await tx
    .update(item)
    .set({ summary: storableText(answer.summary) })
    .where(eq(item.id, itemId));
  // A corrected Rating wins, and this is what makes sure of it.
  const rating = await tx
    .update(item)
    .set({ severity, importance, ratedAt: now() })
    .where(and(eq(item.id, itemId), isNull(item.ratingCorrectedAt)))
    .returning({ id: item.id });
  await tx.insert(itemLog).values(
    rating.length > 0
      ? {
          itemId,
          stage: "rate",
          message: `The Agent rated this Item Severity ${String(severity)}, Importance ${String(importance)}: ${reasoning}`,
          data: { severity, importance, reasoning },
        }
      : {
          itemId,
          stage: "rate",
          message: "The Agent's Rating was dropped: the user corrected this Item's Rating",
          data: { dropped: { severity, importance }, reasoning },
        },
  );

  const log = await logOnce(tx, itemId, "extract");
  for (const rule of rules) {
    const extraction = toExtraction(rule.definition.fields, ({ name }) => foundIn(answer, name));
    await storeExtraction(tx, log, itemId, rule, extraction);
  }
}

/**
 * One call for the Rating, the summary and the Agent-backed Extractor Rules whose Condition the Item
 * meets. Its answer commits with `processed_at`, so a retry never finds half of one. Finishes the Item
 * unless the call failed, and returns that failure, which the Log records.
 */
export async function runExtractAndRate(
  db: Db,
  target: PromptContext["item"] & ConditionItem & { id: string; workspaceId: string },
  deps: AgentDeps,
  now: () => Date,
): Promise<AgentFailure | undefined> {
  const { id: itemId, workspaceId } = target;

  const model = await modelFor(db, itemId, workspaceId);
  if (model === undefined) {
    const message = "Not rated: this Workspace had no model to rate it with";
    await finish(db, itemId, now, async (tx) => {
      await tx.insert(itemLog).values({ itemId, stage: "rate", message });
    });
    return undefined;
  }

  const rules = await applyingRules(db, target);
  const definitions = rules.map((rule) => rule.definition);
  const profile = await loadProfile(db, workspaceId);
  const result = await callAgent({
    db,
    modelConfig: model,
    ...deps,
    workspaceId,
    itemId,
    purpose: "extract-rate",
    schema: ratingSchema(definitions),
    ...buildAgentPrompt(ratingTask(definitions, profile.outputLanguage), {
      profile: profile.body,
      corrections: await recentCorrections(db, workspaceId),
      item: target,
    }),
  });
  if (!result.ok) {
    // Each failure gets its own row. The job's error reaches pg-boss, which stores it as JSONB.
    const message = storableMessage(result.message);
    await db.insert(itemLog).values({
      itemId,
      stage: "rate",
      message: `The extract-and-rate call failed: ${message}`,
      data: { reason: result.reason },
    });
    return { ...result, message };
  }
  await finish(db, itemId, now, (tx) => storeAnswer(tx, itemId, rules, result.output, now));
  return undefined;
}
