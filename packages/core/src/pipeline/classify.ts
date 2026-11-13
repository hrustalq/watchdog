// The Classifier stages (docs: Processing pipeline, "Stages").
import {
  and,
  classifier,
  type Db,
  eq,
  gt,
  inArray,
  isNull,
  item,
  itemCategory,
  itemLog,
  lte,
  modelConfig,
  or,
  type Tx,
} from "@watchdog/db";
import { z } from "zod";
import { type AgentFailure, callAgent, type CallAgentOptions, storableMessage } from "../agent/call-agent.ts";
import { recentCorrections } from "../agent/corrections.ts";
import { loadProfile } from "../agent/profile.ts";
import { buildAgentPrompt, type PromptContext } from "../agent/prompt.ts";
import { type ConditionItem, evaluateCondition } from "../rules/condition.ts";
import { type AgentClassifier, agentClassifierSchema, deterministicClassifierSchema } from "../rules/schema.ts";
import { callFailureInLog } from "./call-failure.ts";
import { logOnce, rulesFor } from "./rules-for-item.ts";

export type AgentDeps = Pick<CallAgentOptions<z.ZodObject>, "encryptionKey" | "fetch">;

const logClassify = (db: Db | Tx, itemId: string, message: string, data: Record<string, unknown>) =>
  db.insert(itemLog).values({ itemId, stage: "classify", message, data });

const logSkipped = (
  log: Awaited<ReturnType<typeof logOnce>>,
  rule: { id: string; name: string },
  error: z.ZodError,
) =>
  log(`Skipped Classifier ${rule.name}: its definition no longer parses`, {
    classifierId: rule.id,
    classifier: rule.name,
    issues: error.issues.map((issue) => issue.message),
  });

/**
 * Runs the Workspace's enabled deterministic Classifiers on an Item, oldest first, so the first
 * Classifier to assign a Category is the one its row names. A retried job runs them again, which
 * changes nothing: their rows are already there.
 */
export async function runDeterministicClassifiers(tx: Tx, itemId: string, target: ConditionItem) {
  const rules = await rulesFor(tx, classifier, itemId, "deterministic");
  if (rules.length === 0) return;
  const log = await logOnce(tx, itemId, "classify");

  for (const rule of rules) {
    const parsed = deterministicClassifierSchema.safeParse(rule.definition);
    if (!parsed.success) {
      await logSkipped(log, rule, parsed.error);
      continue;
    }
    if (!evaluateCondition(parsed.data.when, target)) continue;

    const categories = [...new Set(parsed.data.assign)];
    await tx
      .insert(itemCategory)
      .values(categories.map((category) => ({ itemId, category, classifierId: rule.id })))
      .onConflictDoNothing();
    await log(`Classifier ${rule.name} assigned ${categories.join(", ")}`, {
      classifierId: rule.id,
      classifier: rule.name,
      categories,
    });
  }
}

export async function activeModel(db: Db, workspaceId: string) {
  const [model] = await db
    .select()
    .from(modelConfig)
    .where(and(eq(modelConfig.workspaceId, workspaceId), isNull(modelConfig.archivedAt)));
  return model;
}

/**
 * The Workspace's active model, if it had a model when the Item was captured. Adding the first one
 * later doesn't reach Items already captured, but replacing one does, so a user who fixes a model that
 * was failing gets a retry that works (docs: Processing pipeline, "Without a model").
 */
export async function modelFor(db: Db, itemId: string, workspaceId: string) {
  const hadModel = await db
    .select({ id: modelConfig.id })
    .from(modelConfig)
    .innerJoin(
      item,
      and(
        eq(item.id, itemId),
        eq(item.workspaceId, modelConfig.workspaceId),
        lte(modelConfig.createdAt, item.capturedAt),
        or(isNull(modelConfig.archivedAt), gt(modelConfig.archivedAt, item.capturedAt)),
      ),
    )
    .limit(1);
  return hadModel.length === 0 ? undefined : activeModel(db, workspaceId);
}

interface ParsedRule {
  id: string;
  name: string;
  definition: AgentClassifier;
}

const classifyTask = (rules: ParsedRule[]) =>
  `Decide which Categories fit the Item. Each Classifier below gives its own instructions and the
Categories it may assign. Apply each one, and answer with every Category that fits, or an empty list
when none does. Use the Corrections as examples of how the user judges Items.

Classifiers, as JSON:
${JSON.stringify(rules.map(({ definition }) => definition))}`;

/** Stores what the Agent answered, unless a Correction arrived or another run did it during the call. */
async function storeCategories(
  db: Db,
  itemId: string,
  rules: ParsedRule[],
  answer: string[],
  now: () => Date,
) {
  const categories = [...new Set(answer)];
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ classifiedAt: item.classifiedAt, correctedAt: item.categoriesCorrectedAt })
      .from(item)
      .where(eq(item.id, itemId))
      .for("update");
    if (row?.classifiedAt !== null) return;

    if (row.correctedAt !== null) {
      const message = "The Agent's Categories were dropped: the user corrected this Item's Categories";
      await logClassify(tx, itemId, message, { dropped: categories });
    } else {
      // The lock keeps a Classifier from going before its rows' foreign key is checked.
      const kept = await tx
        .select({ id: classifier.id })
        .from(classifier)
        .where(inArray(classifier.id, rules.map((rule) => rule.id)))
        .for("key share");
      const keptRules = rules.filter((rule) => kept.some(({ id }) => id === rule.id));
      // A Category only a deleted Classifier declares isn't assigned, as with Extractor Rules.
      const assigned = categories.filter((category) =>
        keptRules.some((rule) => rule.definition.categories.includes(category)),
      );
      if (keptRules.length === 0) {
        const message = "The Agent's Categories were dropped: every Classifier was deleted during the call";
        await logClassify(tx, itemId, message, { dropped: categories });
      } else {
        if (assigned.length > 0) {
          await tx
            .insert(itemCategory)
            .values(
              assigned.map((category) => ({
                itemId,
                category,
                // A Category two rules declare goes to the oldest, as with deterministic Classifiers.
                classifierId: keptRules.find((rule) => rule.definition.categories.includes(category))?.id ?? null,
              })),
            )
            .onConflictDoNothing();
        }
        const byRule = keptRules
          .map(({ id, name, definition }) => ({
            classifierId: id,
            classifier: name,
            categories: assigned.filter((category) => definition.categories.includes(category)),
          }))
          .filter((rule) => rule.categories.length > 0);
        const named = byRule.map((rule) => `${rule.classifier} assigned ${rule.categories.join(", ")}`);
        const message =
          assigned.length > 0
            ? `The Agent classified this Item: ${named.join("; ")}`
            : "The Agent assigned no Category";
        await logClassify(tx, itemId, message, { categories: assigned, rules: byRule });
      }
    }
    await tx.update(item).set({ classifiedAt: now() }).where(eq(item.id, itemId));
  });
}

/**
 * One classify call for all the Workspace's enabled Agent-backed Classifiers (docs: Agent and LLM
 * integration, "Calls per Item"). The output schema allows only the Categories they declare, so an
 * Item's text can't invent one. Returns the failure of a failed call, which the Log records.
 */
export async function runAgentClassifiers(
  db: Db,
  target: PromptContext["item"] & { id: string; workspaceId: string },
  deps: AgentDeps,
  now: () => Date,
): Promise<AgentFailure | undefined> {
  const { id: itemId, workspaceId } = target;
  const saved = await rulesFor(db, classifier, itemId, "agent");
  if (saved.length === 0) return undefined;
  const model = await modelFor(db, itemId, workspaceId);
  if (model === undefined) return undefined;

  const log = await logOnce(db, itemId, "classify");
  const rules: ParsedRule[] = [];
  for (const rule of saved) {
    const parsed = agentClassifierSchema.safeParse(rule.definition);
    if (parsed.success) rules.push({ id: rule.id, name: rule.name, definition: parsed.data });
    else await logSkipped(log, rule, parsed.error);
  }
  if (rules.length === 0) return undefined;

  const declared = [...new Set(rules.flatMap((rule) => rule.definition.categories))];
  const result = await callAgent({
    db,
    modelConfig: model,
    ...deps,
    workspaceId,
    itemId,
    purpose: "classify",
    schema: z.object({ categories: z.array(z.enum(declared)) }),
    ...buildAgentPrompt(classifyTask(rules), {
      profile: (await loadProfile(db, workspaceId)).body,
      corrections: await recentCorrections(db, workspaceId),
      item: target,
    }),
  });
  if (!result.ok) {
    // The Log names the cause in plain words, while the call's full detail stays in its meter row and
    // reaches pg-boss as the job's error. Each failure gets its own row.
    await logClassify(db, itemId, `The classify call failed: ${callFailureInLog(result)}`, { reason: result.reason });
    return { ...result, message: storableMessage(result.message) };
  }
  await storeCategories(db, itemId, rules, result.output.categories, now);
  return undefined;
}
