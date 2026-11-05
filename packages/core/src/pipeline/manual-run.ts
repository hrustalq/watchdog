// The manual Extractor Rule run on one Item (docs: Processing pipeline, "Manual runs").
import { and, type Db, eq, extractorRule, item, itemField, itemLog, source, type Tx } from "@watchdog/db";
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
 * Item before, and a failure leaves those in place. Returns the id of the run's Log row, or undefined
 * when the Item or the rule isn't in this Workspace.
 */
export async function runExtractorRuleByHand(
  db: Db,
  { workspaceId, itemId, ruleId }: Run,
  deps: AgentDeps,
): Promise<number | undefined> {
  const [found] = await db
    .select({ item, sourceName: source.name, rule: extractorRule })
    .from(item)
    .innerJoin(source, eq(item.sourceId, source.id))
    .innerJoin(extractorRule, and(eq(extractorRule.id, ruleId), eq(extractorRule.workspaceId, workspaceId)))
    .where(and(eq(item.id, itemId), eq(item.workspaceId, workspaceId)));
  if (found === undefined) return undefined;
  const { item: target, sourceName, rule } = found;
  const named = { extractorRuleId: rule.id, extractor: rule.name };

  const failure = (tx: Tx, reason: string, data: Record<string, unknown> = {}) =>
    logRun(tx, itemId, `Extractor Rule ${rule.name} failed: ${reason}`, { ...named, ...data, failed: true });
  const fail = (reason: string, data?: Record<string, unknown>) =>
    withItem(db, itemId, (tx) => failure(tx, reason, data));
  const unreadable = "its definition no longer parses";

  const store = (extraction: Extraction) =>
    withItem(db, itemId, async (tx) => {
      // The lock keeps the rule from going before its row's foreign key is checked.
      const kept = await tx
        .select({ id: extractorRule.id })
        .from(extractorRule)
        .where(eq(extractorRule.id, rule.id))
        .for("key share");
      if (kept.length === 0) return failure(tx, "the rule was deleted during the run");
      await tx
        .delete(itemField)
        .where(and(eq(itemField.itemId, itemId), eq(itemField.extractorRuleId, rule.id)));
      let logged: number | undefined;
      const log = async (message: string, data: Record<string, unknown>) => {
        logged = await logRun(tx, itemId, message, data);
      };
      await storeExtraction(tx, log, itemId, rule, extraction);
      return logged;
    });

  if (rule.kind === "deterministic") {
    const parsed = deterministicExtractorRuleSchema.safeParse(rule.definition);
    return parsed.success ? store(extractFields(parsed.data.fields, target)) : fail(unreadable);
  }

  const parsed = agentExtractorRuleSchema.safeParse(rule.definition);
  if (!parsed.success) return fail(unreadable);
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
