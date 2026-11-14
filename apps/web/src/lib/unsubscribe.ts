// One-click unsubscribe from a Digest mail (docs: Actions and delivery, "Digests"; Security and privacy,
// "The unsubscribe URL"). No session: the token's signature is the check.
import { checkUnsubscribeToken } from "@watchdog/core";
import { action, actionDestination, and, type Db, digestItem, eq, sql } from "@watchdog/db";
import { definitionWithout } from "./destinations.ts";

export type UnsubscribeResult = "invalid" | "removed" | "disabled" | "already";

/**
 * Takes the token's Destination off its Digest, or disables the Digest and keeps the Destination when it
 * was the only one, as deleting a Destination leaves an Action. Neither is a save, so `updated_at` stays,
 * because the Act stage compares it with an Item's capture. The Action's row is taken first with no key
 * update, as removing a Destination takes it, so the two can't deadlock.
 */
export async function unsubscribe(db: Db, token: string, secret: string): Promise<UnsubscribeResult> {
  const named = checkUnsubscribeToken(token, secret);
  if (named === undefined) return "invalid";
  const { actionId, destinationId } = named;
  return db.transaction(async (tx) => {
    const [digest] = await tx
      .select({ enabled: action.enabled })
      .from(action)
      .where(and(eq(action.id, actionId), eq(action.kind, "digest")))
      .for("no key update");
    if (digest === undefined) return "already";
    const pointsAt = await tx
      .select({ destinationId: actionDestination.destinationId })
      .from(actionDestination)
      .where(eq(actionDestination.actionId, actionId));
    if (!pointsAt.some((row) => row.destinationId === destinationId)) return "already";

    const notASave = { updatedAt: sql`${action.updatedAt}` };
    if (pointsAt.length === 1) {
      if (!digest.enabled) return "already";
      await tx.update(action).set({ enabled: false, ...notASave }).where(eq(action.id, actionId));
      return "disabled";
    }
    await tx
      .delete(actionDestination)
      .where(and(eq(actionDestination.actionId, actionId), eq(actionDestination.destinationId, destinationId)));
    // It said stop, so what this Digest had collected for it isn't kept for it.
    await tx
      .delete(digestItem)
      .where(and(eq(digestItem.actionId, actionId), eq(digestItem.destinationId, destinationId)));
    await tx
      .update(action)
      .set({
        definition: definitionWithout(destinationId),
        ...notASave,
      })
      .where(eq(action.id, actionId));
    return "removed";
  });
}
