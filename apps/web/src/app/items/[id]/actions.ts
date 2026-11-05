"use server";

import { runExtractorRuleByHand } from "@watchdog/core";
import { redirect } from "next/navigation";
import { requireWorkspace, server } from "@/lib/server";
import { isUuid } from "@/lib/uuid";

/**
 * Runs an Extractor Rule on an Item, in this request, because the user is waiting for it. Bound
 * arguments come back from the client, and an id outside the user's Workspace runs nothing. The page
 * reads the outcome from the run's Log row.
 */
export async function runExtractorRuleAction(itemId: unknown, ruleId: unknown) {
  const { workspace } = await requireWorkspace();
  if (typeof itemId !== "string" || !isUuid(itemId)) redirect("/");
  const { db, agentFetch, encryptionKey } = server();
  const runId =
    typeof ruleId === "string" && isUuid(ruleId)
      ? await runExtractorRuleByHand(
          db,
          { workspaceId: workspace.id, itemId, ruleId },
          { fetch: agentFetch, encryptionKey },
        )
      : undefined;
  redirect(runId === undefined ? `/items/${itemId}` : `/items/${itemId}?run=${String(runId)}`);
}
