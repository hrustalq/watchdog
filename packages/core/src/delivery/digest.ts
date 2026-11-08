// Sends a Digest on its schedule: the Items it collected, in one message per Destination (docs: Actions
// and delivery, "Digests" and "Deliveries"). The worker's sweep finds the due ones, and a job per Digest
// sends it.
import {
  action,
  actionDestination,
  and,
  type Db,
  destination,
  digestItem,
  eq,
  inArray,
  item,
  itemLog,
  sql,
  type Tx,
  workspace,
} from "@watchdog/db";
import { storableMessage } from "../agent/call-agent.ts";
import { actionSchema } from "../rules/schema.ts";
import { nextFiring } from "../schedule.ts";
import { type DeliverDeps, type Destination, failureReason, recordSentMessage } from "./deliver.ts";
import { type EmailCap, emailCapEnd, queueCapNoticeOnce, takeEmailCapTurn } from "./email-cap.ts";
import { groupedAlert } from "./group.ts";
import { unsubscribeUrl } from "./unsubscribe.ts";

export interface DigestDeps {
  senders: Pick<DeliverDeps["senders"], "telegram" | "email">;
  /** Where Watchdog is served, for the links to the Items and the unsubscribe URL. */
  appUrl: string;
  /** BETTER_AUTH_SECRET, from which the unsubscribe URL's key is derived. */
  secret: string;
  /** The hosted daily cap, which Digest mail counts toward. Self-hosted has none. */
  emailCap?: EmailCap;
  now?: () => Date;
}

function digestOf(definition: unknown) {
  const parsed = actionSchema.safeParse(definition);
  return parsed.success && parsed.data.kind === "digest" ? parsed.data : undefined;
}

interface Schedulable {
  definition: unknown;
  digestRanAt: Date | null;
  updatedAt: Date;
  timezone: string;
}

/**
 * Whether the Digest's schedule has come since it last ran, or since it was saved, whichever is later.
 * Reading it from those each time means a save, enabling it or a new timezone takes effect at once.
 */
function isDue({ definition, digestRanAt, updatedAt, timezone }: Schedulable, now: Date) {
  const digest = digestOf(definition);
  if (digest === undefined) return false;
  const since = digestRanAt !== null && digestRanAt > updatedAt ? digestRanAt : updatedAt;
  try {
    return nextFiring(digest.schedule, since, timezone) <= now;
  } catch {
    // A timezone Intl doesn't know. The Settings screen checks it, so this is a row written by hand.
    return false;
  }
}

/** The enabled Digests whose schedule has come. */
export async function dueDigests(db: Db, now: Date) {
  const digests = await db
    .select({
      id: action.id,
      definition: action.definition,
      digestRanAt: action.digestRanAt,
      updatedAt: action.updatedAt,
      timezone: workspace.timezone,
    })
    .from(action)
    .innerJoin(workspace, eq(workspace.id, action.workspaceId))
    .where(and(eq(action.kind, "digest"), eq(action.enabled, true)));
  return digests.filter((digest) => isDue(digest, now)).map(({ id }) => id);
}

/** A send, or a Destination skipped with the Log's sentence about it. */
type Outcome = { target: Destination; error?: unknown } | { skipped: string; data: Record<string, unknown> };

/**
 * Sends a Digest if its schedule has come, and records that it ran. An empty one sends nothing and
 * writes no Log row. The Items go to each Destination as one message, and those rows are deleted once
 * any Destination got them, so an Item is never in two sends. When none did, they wait for the next one.
 *
 * It holds key share on the Action, as the Act stage does, so an edit or a delete waits for it, and its
 * Destinations' rows through the sends, as a Delivery does, so removing one waits too. Neither lock
 * conflicts with what removing a Destination or unsubscribing takes on the Action, so none can deadlock.
 */
export async function sendDigest(db: Db, actionId: string, deps: DigestDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  await db.transaction(async (tx) => {
    const [found] = await tx
      .select({ action, settings: workspace })
      .from(action)
      .innerJoin(workspace, eq(workspace.id, action.workspaceId))
      .where(and(eq(action.id, actionId), eq(action.kind, "digest"), eq(action.enabled, true)))
      .for("key share", { of: action });
    if (found === undefined) return;
    const { settings } = found;
    const startedAt = now();
    if (!isDue({ ...found.action, timezone: settings.timezone }, startedAt)) return;
    const name = found.action.name;

    const targets = await tx
      .select({ destination })
      .from(actionDestination)
      .innerJoin(destination, eq(destination.id, actionDestination.destinationId))
      .where(eq(actionDestination.actionId, actionId))
      .orderBy(destination.id)
      .for("no key update", { of: destination });
    // Locked, so a second job for this Digest finds them gone.
    const pending = await tx
      .select({ id: item.id, title: item.title, severity: item.severity, importance: item.importance })
      .from(digestItem)
      .innerJoin(item, eq(item.id, digestItem.itemId))
      .where(eq(digestItem.actionId, actionId))
      .orderBy(sql`${item.topScore} desc nulls last`, sql`${item.capturedAt} desc`, sql`${item.id} desc`)
      .for("update", { of: digestItem });

    // The Rules screen refuses a webhook Destination on a Digest.
    const sendable = targets
      .map((row) => row.destination)
      .filter((target): target is Destination & { type: "telegram" | "email" } => target.type !== "webhook");
    // Removed while this waited for its row: the Action read above still lists it, by id only.
    const removed = (digestOf(found.action.definition)?.destinations ?? []).filter(
      (id) => !targets.some((row) => row.destination.id === id),
    );
    const mailing = sendable.some((target) => target.type === "email" && target.confirmedAt !== null);
    if (pending.length > 0 && mailing && deps.emailCap !== undefined) {
      // Held whole until the next local day, and sent as this Digest then. It stays due, so each tick
      // tries again, and the check is a count.
      await takeEmailCapTurn(tx, settings.id);
      const capEnd = await emailCapEnd(tx, settings, startedAt);
      if (capEnd !== undefined) {
        await queueCapNoticeOnce(tx, settings, capEnd, deps.emailCap);
        return;
      }
    }

    // Not a save: the Act stage compares updated_at with an Item's capture.
    await tx
      .update(action)
      .set({ digestRanAt: startedAt, updatedAt: sql`${action.updatedAt}` })
      .where(eq(action.id, actionId));
    if (pending.length === 0) return;

    const outcomes: Outcome[] = removed.map((id) => ({
      skipped: `Skipped a Destination in the Digest ${name}: it was removed`,
      data: { actionId, destinationId: id },
    }));
    for (const target of sendable) {
      if (target.confirmedAt === null) {
        outcomes.push({
          skipped: `Skipped ${target.name} in the Digest ${name}: not confirmed yet`,
          data: { actionId, destinationId: target.id, destination: target.name },
        });
        continue;
      }
      const message = {
        ...groupedAlert(pending, deps.appUrl),
        digest: name,
        ...(target.type === "email" && { unsubscribeUrl: unsubscribeUrl(deps.appUrl, deps.secret, actionId, target.id) }),
      };
      try {
        await deps.senders[target.type].send(target, message);
        outcomes.push({ target });
      } catch (error) {
        outcomes.push({ target, error });
      }
    }
    await record(tx, { actionId, name, itemIds: pending.map(({ id }) => id), outcomes, sentAt: now() });
  });
}

async function record(
  tx: Tx,
  { actionId, name, itemIds, outcomes, sentAt }: { actionId: string; name: string; itemIds: string[]; outcomes: Outcome[]; sentAt: Date },
) {
  const anySent = outcomes.some((outcome) => "target" in outcome && outcome.error === undefined);
  const after = anySent ? "It won't be sent again" : "It waits for the next Digest";
  for (const outcome of outcomes) {
    let message: string;
    let data: Record<string, unknown>;
    if ("skipped" in outcome) {
      ({ skipped: message, data } = outcome);
    } else {
      const { target, error } = outcome;
      const named = { actionId, destinationId: target.id, destination: target.name };
      if (error === undefined) {
        message = `Sent in the Digest ${name} to ${target.name}`;
        data = { ...named, digest: "sent" };
        await recordSentMessage(tx, target, sentAt);
        await tx.update(destination).set({ lastError: null, lastErrorAt: null }).where(eq(destination.id, target.id));
      } else {
        const reason = failureReason(error);
        message = `Sending the Digest ${name} to ${target.name} failed: ${reason}. ${after}`;
        data = { ...named, final: true };
        await tx.update(destination).set({ lastError: reason, lastErrorAt: sentAt }).where(eq(destination.id, target.id));
      }
    }
    await tx
      .insert(itemLog)
      .values(itemIds.map((itemId) => ({ itemId, stage: "act" as const, message: storableMessage(message), data })));
  }
  if (anySent) await tx.delete(digestItem).where(and(eq(digestItem.actionId, actionId), inArray(digestItem.itemId, itemIds)));
}
