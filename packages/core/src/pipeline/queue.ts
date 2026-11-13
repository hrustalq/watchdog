// The process-item queues, which the worker runs and both the worker and web send to (docs: Processing
// pipeline, "The pipeline job"; Agent and LLM integration, "Limits").
import { and, inArray, isNull, item, modelConfig, sql, type Tx } from "@watchdog/db";
import { fromDrizzle, type PgBoss } from "pg-boss";
import type { CaptureDeps } from "./capture.ts";

/**
 * Items whose Workspace has no model, so no stage can reach the Agent. The worker runs these beside
 * the Agent jobs, so an Item that needs no model isn't held behind one (docs: Agent and LLM
 * integration, "Limits").
 */
export const processItemQueue = "process-item";

/**
 * Items whose Workspace has a model, so the job may make an Agent call. The worker groups these by
 * Workspace and caps each group, so one Workspace's slow model can't take every Agent slot.
 */
export const agentItemQueue = "process-item-agent";

/**
 * The Items, and which of their Workspaces have a model right now. Only such a job can make an
 * Agent call: a model added after the capture doesn't reach the Item, and an archived one is gone.
 */
async function itemsWithModel(tx: Tx, itemIds: string[]) {
  const saved = await tx
    .select({ id: item.id, workspaceId: item.workspaceId })
    .from(item)
    .where(inArray(item.id, itemIds));
  const workspaceIds = [...new Set(saved.map((row) => row.workspaceId))];
  if (workspaceIds.length === 0) return { saved, withModel: new Set<string>() };
  const modelled = await tx
    .select({ workspaceId: modelConfig.workspaceId })
    .from(modelConfig)
    .where(and(inArray(modelConfig.workspaceId, workspaceIds), isNull(modelConfig.archivedAt)));
  return { saved, withModel: new Set(modelled.map((row) => row.workspaceId)) };
}

/**
 * Queues one job per Item over the capture's transaction, so they commit or roll back together. An
 * Item whose Workspace has a model goes to the Agent queue in a group named after that Workspace,
 * which is what holds it to the Workspace's share of the Agent slots.
 */
export function itemEnqueuer(boss: PgBoss): CaptureDeps["enqueueItems"] {
  return async (tx, itemIds) => {
    if (itemIds.length === 0) return;
    const { saved, withModel } = await itemsWithModel(tx, itemIds);
    const db = fromDrizzle(tx, sql);
    const plain = saved
      .filter((row) => !withModel.has(row.workspaceId))
      .map(({ id }) => ({ data: { itemId: id } }));
    const agent = saved
      .filter((row) => withModel.has(row.workspaceId))
      .map(({ id, workspaceId }) => ({ data: { itemId: id }, group: { id: workspaceId } }));
    if (plain.length > 0) await boss.insert(processItemQueue, plain, { db });
    if (agent.length > 0) await boss.insert(agentItemQueue, agent, { db });
  };
}
