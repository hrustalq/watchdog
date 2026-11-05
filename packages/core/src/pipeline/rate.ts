// The extract-and-rate stage (docs: Processing pipeline, "Stages"; Agent and LLM integration, "Calls
// per Item").
import { and, type Db, eq, extractorRule, inArray, isNull, item, itemLog, type Tx } from "@watchdog/db";
import type { z } from "zod";
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

type Answer = z.output<ReturnType<typeof ratingSchema>>;
type Target = PromptContext["item"] & ConditionItem & { id: string; workspaceId: string };

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

/**
 * What a field found, the shape `toExtraction` reads. Null and blank mean the Item has none. A model's
 * answer can hold what Postgres refuses, and asking again wouldn't change that.
 */
export function foundIn(answer: Record<string, unknown>, name: string): unknown[] {
  return [answer[fieldKey(name)]]
    .flat()
    .map((value) => (typeof value === "string" ? storableText(value) : value))
    .filter((value) => value !== null && (typeof value !== "string" || value.trim() !== ""));
}

/** Stores each rule's fields, unless the rule was deleted or its Condition stopped holding during the call. */
async function storeFields(tx: Tx, target: Target, rules: ParsedRule[], answer: Answer) {
  if (rules.length === 0) return;
  // The lock keeps a rule from going before its row's foreign key is checked.
  const kept = await tx
    .select({ id: extractorRule.id })
    .from(extractorRule)
    .where(inArray(extractorRule.id, rules.map((rule) => rule.id)))
    .for("key share");
  const categories = await categoriesOf(tx, target.id);
  const log = await logOnce(tx, target.id, "extract");
  for (const rule of rules) {
    if (!kept.some(({ id }) => id === rule.id)) continue;
    if (!evaluateCondition(rule.definition.when, { ...target, categories })) continue;
    const extraction = toExtraction(rule.definition.fields, ({ name }) => foundIn(answer, name));
    await storeExtraction(tx, log, target.id, rule, extraction);
  }
}

async function storeAnswer(tx: Tx, target: Target, rules: ParsedRule[], answer: Answer, now: () => Date) {
  const itemId = target.id;
  const { severity, importance } = answer;
  // The Log holds a readable sentence, and a model can run on.
  const reasoning = storableMessage(answer.reasoning);
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
  await tx.insert(itemLog).values({
    itemId,
    stage: "rate",
    ...(rating.length > 0
      ? {
          message: `The Agent rated this Item Severity ${String(severity)}, Importance ${String(importance)}: ${reasoning}`,
          data: { severity, importance, reasoning },
        }
      : {
          message: "The Agent's Rating was dropped: the user corrected this Item's Rating",
          data: { dropped: { severity, importance }, reasoning },
        }),
  });
  await storeFields(tx, target, rules, answer);
}

/**
 * One call for the Rating, the summary and the Agent-backed Extractor Rules whose Condition the Item
 * meets. Its answer commits with `processed_at`, so a retry never finds half of one. Finishes the Item
 * unless the call failed, and returns that failure, which the Log records.
 */
export async function runExtractAndRate(
  db: Db,
  target: Target,
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
  await finish(db, itemId, now, (tx) => storeAnswer(tx, target, rules, result.output, now));
  return undefined;
}
