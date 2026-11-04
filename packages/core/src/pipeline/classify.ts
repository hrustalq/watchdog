// The deterministic Classifier stage (docs: Processing pipeline, "Stages").
import { classifier, itemCategory, itemLog, type Tx } from "@watchdog/db";
import { type ConditionItem, evaluateCondition } from "../rules/condition.ts";
import { deterministicClassifierSchema } from "../rules/schema.ts";
import { deterministicRulesFor } from "./deterministic-rules.ts";

/**
 * Runs the Workspace's enabled deterministic Classifiers on an Item, oldest first, so the first
 * Classifier to assign a Category is the one its row names.
 */
export async function runDeterministicClassifiers(tx: Tx, itemId: string, target: ConditionItem) {
  const rules = await deterministicRulesFor(tx, classifier, itemId);

  const log = (message: string, data: Record<string, unknown>) =>
    tx.insert(itemLog).values({ itemId, stage: "classify", message, data });

  for (const rule of rules) {
    const parsed = deterministicClassifierSchema.safeParse(rule.definition);
    if (!parsed.success) {
      await log(`Skipped Classifier ${rule.name}: its definition no longer parses`, {
        classifierId: rule.id,
        classifier: rule.name,
        issues: parsed.error.issues.map((issue) => issue.message),
      });
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
