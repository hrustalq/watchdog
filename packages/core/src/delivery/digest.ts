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
  sentMessage,
  sql,
  workspace,
} from "@watchdog/db";
import { storableMessage } from "../agent/call-agent.ts";
import { actionSchema } from "../rules/schema.ts";
import { nextFiring } from "../schedule.ts";
import { localTime } from "./schedule-delivery.ts";
import { type DeliverDeps, type Destination, failureReason } from "./deliver.ts";
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

type Sendable = Destination & { type: "telegram" | "email" };

/** What a claimed send goes out with: the Items, and each Destination with its reserved `sent_message` row. */
interface Claim {
  name: string;
  items: { id: string; title: string | null; severity: number | null; importance: number | null }[];
  sends: { target: Sendable; reservation: string }[];
  /** The Log's sentences for the Destinations it passes over. */
  skipped: { message: string; data: Record<string, unknown> }[];
  /** The schedule's next time, in words and as an instant, for a send that has to wait for it. */
  next: { at: Date; words: string } | undefined;
}

/**
 * Takes this firing in a short transaction: checks the Digest is due, reads its Items, records that its
 * schedule ran, and counts its messages in `sent_message` before they go, so the hosted cap can't be
 * passed by mail sent while this one waits. Undefined when there's nothing to send, or the cap holds it.
 */
async function claim(db: Db, actionId: string, deps: DigestDeps, startedAt: Date): Promise<Claim | undefined> {
  return db.transaction(async (tx) => {
    // Briefly, so two jobs can't both claim one firing. Removing a Destination takes the same lock after
    // the Destination's row, which this never locks, so the two can't deadlock.
    const [found] = await tx
      .select({ action, settings: workspace })
      .from(action)
      .innerJoin(workspace, eq(workspace.id, action.workspaceId))
      .where(and(eq(action.id, actionId), eq(action.kind, "digest"), eq(action.enabled, true)))
      .for("no key update", { of: action });
    const digest = found && digestOf(found.action.definition);
    if (found === undefined || digest === undefined) return undefined;
    const { settings } = found;
    if (!isDue({ ...found.action, timezone: settings.timezone }, startedAt)) return undefined;
    // Not a save: the Act stage compares updated_at with an Item's capture.
    const ran = () =>
      tx.update(action).set({ digestRanAt: startedAt, updatedAt: sql`${action.updatedAt}` }).where(eq(action.id, actionId));

    const items = await tx
      .select({ id: item.id, title: item.title, severity: item.severity, importance: item.importance })
      .from(digestItem)
      .innerJoin(item, eq(item.id, digestItem.itemId))
      .where(eq(digestItem.actionId, actionId))
      .orderBy(sql`${item.topScore} desc nulls last`, sql`${item.capturedAt} desc`, sql`${item.id} desc`);
    if (items.length === 0) {
      await ran();
      return undefined;
    }

    const targets = await tx
      .select({ destination })
      .from(actionDestination)
      .innerJoin(destination, eq(destination.id, actionDestination.destinationId))
      .where(eq(actionDestination.actionId, actionId))
      .orderBy(destination.name);
    const name = found.action.name;
    const skipped: Claim["skipped"] = targets
      .filter(({ destination: target }) => target.confirmedAt === null)
      .map(({ destination: target }) => ({
        message: `Skipped ${target.name} in the Digest ${name}: not confirmed yet`,
        data: { actionId, destinationId: target.id, destination: target.name },
      }));
    // Listed by the Action but gone from its foreign keys: removed since, by id only.
    for (const id of digest.destinations.filter((listed) => !targets.some((row) => row.destination.id === listed))) {
      skipped.push({ message: `Skipped a Destination in the Digest ${name}: it was removed`, data: { actionId, destinationId: id } });
    }
    // The Rules screen refuses a webhook Destination on a Digest.
    const confirmed = targets
      .map((row) => row.destination)
      .filter((target): target is Sendable => target.type !== "webhook" && target.confirmedAt !== null);

    const mails = confirmed.filter((target) => target.type === "email").length;
    if (mails > 0 && deps.emailCap !== undefined) {
      // Held whole until a local day has room for every address, and sent as this Digest then. It stays
      // due, so each tick tries again, and the check is a count.
      await takeEmailCapTurn(tx, settings.id);
      const capEnd = await emailCapEnd(tx, settings, startedAt, mails);
      if (capEnd !== undefined) {
        await queueCapNoticeOnce(tx, settings, capEnd, deps.emailCap);
        return undefined;
      }
    }

    await ran();
    const sends = [];
    for (const target of confirmed) {
      const [reserved] = await tx
        .insert(sentMessage)
        .values({ workspaceId: settings.id, destinationId: target.id, type: target.type, sentAt: startedAt })
        .returning({ id: sentMessage.id });
      if (reserved !== undefined) sends.push({ target, reservation: reserved.id });
    }
    let next: Claim["next"];
    try {
      const at = nextFiring(digest.schedule, startedAt, settings.timezone);
      next = { at, words: `${localTime(at, settings.timezone)} (${settings.timezone})` };
    } catch {
      next = undefined;
    }
    return { name, items, sends, skipped, next };
  });
}

interface Outcome {
  target: Sendable;
  reservation: string;
  error?: unknown;
}

/**
 * Sends a Digest if its schedule has come. An empty one sends nothing and writes no Log row. The Items go
 * to each confirmed Destination as one message, and leave the Digest once any Destination got them, so
 * an Item is never in two sends. When none did, they wait for the next one.
 *
 * No transaction is open during the sends, so an unsubscribe, an edit or a Delivery to the same
 * Destination never waits for a mail server. The firing is claimed before them and recorded after, so a
 * failure in between costs at most one repeat, in the next firing, not one per retry of the job.
 */
export async function sendDigest(db: Db, actionId: string, deps: DigestDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const claimed = await claim(db, actionId, deps, now());
  if (claimed === undefined) return;
  const { name, items, sends } = claimed;

  const outcomes: Outcome[] = [];
  for (const send of sends) {
    const message = {
      ...groupedAlert(items, deps.appUrl),
      digest: name,
      ...(send.target.type === "email" && {
        unsubscribeUrl: unsubscribeUrl(deps.appUrl, deps.secret, actionId, send.target.id),
      }),
    };
    try {
      await deps.senders[send.target.type].send(send.target, message);
      outcomes.push(send);
    } catch (error) {
      outcomes.push({ ...send, error });
    }
  }
  await record(db, actionId, claimed, outcomes, now());
}

/**
 * Writes each Item's Log, keeps a failed send's error on its Destination and gives back its place in the
 * count, and empties the Digest of these Items when any Destination got them. Skipped Destinations are
 * written only then, once per Item, rather than at every firing an Item waits through.
 */
async function record(db: Db, actionId: string, claimed: Claim, outcomes: Outcome[], at: Date) {
  const { name, next } = claimed;
  const anySent = outcomes.some(({ error }) => error === undefined);
  await db.transaction(async (tx) => {
    // Held until the commit, so an Item deleted during the sends doesn't fail its Log's foreign key.
    const present = await tx
      .select({ id: item.id })
      .from(item)
      .where(inArray(item.id, claimed.items.map(({ id }) => id)))
      .for("key share");
    const log = async (message: string, data: Record<string, unknown>) => {
      if (present.length === 0) return;
      await tx
        .insert(itemLog)
        .values(present.map(({ id }) => ({ itemId: id, stage: "act" as const, message: storableMessage(message), data })));
    };

    for (const { target, reservation, error } of outcomes) {
      const named = { actionId, destinationId: target.id, destination: target.name };
      if (error === undefined) {
        await log(`Sent in the Digest ${name} to ${target.name}`, { ...named, digest: "sent" });
        await tx.update(destination).set({ lastError: null, lastErrorAt: null }).where(eq(destination.id, target.id));
        continue;
      }
      const reason = failureReason(error);
      await tx.delete(sentMessage).where(eq(sentMessage.id, reservation));
      await tx.update(destination).set({ lastError: reason, lastErrorAt: at }).where(eq(destination.id, target.id));
      const failure = `Sending the Digest ${name} to ${target.name} failed: ${reason}`;
      if (anySent) {
        await log(`${failure}. It won't be sent again`, { ...named, digest: "failed", reason, final: true });
      } else if (next === undefined) {
        await log(`${failure}. It waits for the next Digest`, { ...named, final: false });
      } else {
        await log(`${failure}. It waits for the next Digest, at ${next.words}`, { ...named, retryAt: next.at.toISOString() });
      }
    }
    if (!anySent) return;
    for (const { message, data } of claimed.skipped) await log(message, data);
    await tx.delete(digestItem).where(and(eq(digestItem.actionId, actionId), inArray(digestItem.itemId, claimed.items.map(({ id }) => id))));
  });
}
