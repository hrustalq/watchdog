// The manual Extractor Rule run on one Item (docs: Processing pipeline, "Manual runs").
import {
  and,
  type Db,
  eq,
  extractorRule,
  inArray,
  isNull,
  item,
  itemField,
  itemLog,
  notInArray,
  or,
  source,
  type Tx,
} from "@watchdog/db";
import type { z } from "zod";
import { callAgent, storableMessage } from "../agent/call-agent.ts";
import { recentCorrections } from "../agent/corrections.ts";
import { loadProfile } from "../agent/profile.ts";
import { buildAgentPrompt } from "../agent/prompt.ts";
import { manualRunSchema, manualRunTask } from "../agent/rating.ts";
import { agentExtractorRuleSchema, deterministicExtractorRuleSchema } from "../rules/schema.ts";
import { activeModel, type AgentDeps } from "./classify.ts";
import { type Extraction, extractFields, storeExtraction, toExtraction } from "./extract.ts";
import { foundIn } from "./rate.ts";

interface Run {
  workspaceId: string;
  itemId: string;
  ruleId: string;
}

/** Each run gets its own row, marked manual, so a run that says the same as the last still shows. */
async function logRun(tx: Tx, itemId: string, message: string, data: Record<string, unknown>) {
  const [row] = await tx
    .insert(itemLog)
    .values({ itemId, stage: "extract", message: `Manual run: ${message}`, data: { ...data, manual: true } })
    .returning({ id: itemLog.id });
  return row?.id;
}

/** Runs `work` with the Item's row locked, so runs take turns. Undefined when the Item is gone. */
function withItem<Result>(db: Db, itemId: string, work: (tx: Tx) => Promise<Result>) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ id: item.id }).from(item).where(eq(item.id, itemId)).for("update");
    return row === undefined ? undefined : work(tx);
  });
}

/**
 * Runs one Extractor Rule on one Item, enabled or not. Choosing the Item is the user's decision, so
 * neither the rule's Condition nor when it was saved applies. Its results replace what it stored on the
 * Item before, and a failure leaves those in place. It waits until the pipeline has finished with the
 * Item, because a job that is still running decides which rule keeps a field. Returns the id of the
 * run's Log row, or undefined when the Item or the rule isn't in this Workspace.
 */
export async function runExtractorRuleByHand(
  db: Db,
  { workspaceId, itemId, ruleId }: Run,
  deps: AgentDeps,
): Promise<number | undefined> {
  const [found] = await db
    .select({ item, sourceName: source.name, sourceType: source.type, rule: extractorRule })
    .from(item)
    .innerJoin(source, eq(item.sourceId, source.id))
    .innerJoin(extractorRule, and(eq(extractorRule.id, ruleId), eq(extractorRule.workspaceId, workspaceId)))
    .where(and(eq(item.id, itemId), eq(item.workspaceId, workspaceId)));
  if (found === undefined) return undefined;
  const { item: target, sourceName, sourceType, rule } = found;
  const named = { extractorRuleId: rule.id, extractor: rule.name };

  const failure = (tx: Tx, reason: string, data: Record<string, unknown> = {}) =>
    logRun(tx, itemId, `Extractor Rule ${rule.name} failed: ${reason}`, {
      ...named,
      ...data,
      // `reason` holds the call's failure type, so the sentence a person reads needs a key of its own.
      detail: reason,
      failed: true,
    });
  const fail = (reason: string, data?: Record<string, unknown>) =>
    withItem(db, itemId, (tx) => failure(tx, reason, data));
  const unreadable = (error: z.ZodError) =>
    fail("its definition no longer parses", { issues: error.issues.map((issue) => issue.message) });
  if (target.processedAt === null) return fail("the pipeline hasn't finished with this Item yet");

  const store = (extraction: Extraction) =>
    withItem(db, itemId, async (tx) => {
      // The lock keeps the rule from going before its row's foreign key is checked.
      const kept = await tx
        .select({ id: extractorRule.id })
        .from(extractorRule)
        .where(eq(extractorRule.id, rule.id))
        .for("key share");
      if (kept.length === 0) return failure(tx, "the rule was deleted during the run");
      const couldNotStore = extraction.problems.map(({ name }) => name);
      const filled = extraction.values.map(({ name }) => name);
      await tx.delete(itemField).where(
        and(
          eq(itemField.itemId, itemId),
          or(
            and(eq(itemField.extractorRuleId, rule.id), notInArray(itemField.name, couldNotStore)),
            // No rule holds a field whose rule was deleted, so it can't count as filled by another.
            and(isNull(itemField.extractorRuleId), inArray(itemField.name, filled)),
          ),
        ),
      );
      let logged: number | undefined;
      const log = async (message: string, data: Record<string, unknown>) => {
        logged = await logRun(tx, itemId, message, data);
      };
      await storeExtraction(tx, log, itemId, rule, extraction);
      return logged;
    });

  if (rule.kind === "deterministic") {
    const parsed = deterministicExtractorRuleSchema.safeParse(rule.definition);
    return parsed.success ? store(extractFields(parsed.data.fields, { ...target, sourceType })) : unreadable(parsed.error);
  }

  const parsed = agentExtractorRuleSchema.safeParse(rule.definition);
  if (!parsed.success) return unreadable(parsed.error);
  const model = await activeModel(db, workspaceId);
  if (model === undefined) return fail("this Workspace has no model");
  const definition = parsed.data;
  const result = await callAgent({
    db,
    modelConfig: model,
    ...deps,
    workspaceId,
    itemId,
    purpose: "extract-rate",
    schema: manualRunSchema(definition),
    ...buildAgentPrompt(manualRunTask(definition), {
      profile: (await loadProfile(db, workspaceId)).body,
      corrections: await recentCorrections(db, workspaceId),
      item: { ...target, sourceName },
    }),
  });
  if (!result.ok) return fail(storableMessage(result.message), { reason: result.reason });
  return store(toExtraction(definition.fields, ({ name }) => foundIn(result.output, name)));
}
