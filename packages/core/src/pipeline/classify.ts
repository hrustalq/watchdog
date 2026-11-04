// The deterministic Classifier stage (docs: Processing pipeline, "Stages").
import { and, classifier, eq, item, itemCategory, itemLog, lte, type Tx } from "@watchdog/db";
import { type ConditionItem, evaluateCondition } from "../rules/condition.ts";
import { deterministicClassifierSchema } from "../rules/schema.ts";

/**
 * Runs the Workspace's enabled deterministic Classifiers on an Item, oldest first, so the first
 * Classifier to assign a Category is the one its row names. A rule saved after the Item was captured
 * doesn't apply to it, even when the job ran late (docs: Processing pipeline, "When rules change").
 * That's compared in SQL, because a JS Date would cut captured_at to the millisecond.
 */
export async function runDeterministicClassifiers(tx: Tx, itemId: string, target: ConditionItem) {
  const rules = await tx
    .select({ id: classifier.id, name: classifier.name, definition: classifier.definition })
    .from(classifier)
    .innerJoin(
      item,
      and(
        eq(item.id, itemId),
        eq(item.workspaceId, classifier.workspaceId),
        lte(classifier.updatedAt, item.capturedAt),
      ),
    )
    .where(and(eq(classifier.kind, "deterministic"), eq(classifier.enabled, true)))
    .orderBy(classifier.createdAt, classifier.id);

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
