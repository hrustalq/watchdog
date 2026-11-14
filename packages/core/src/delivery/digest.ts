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
  lte,
  sentMessage,
  sql,
  workspace,
} from "@watchdog/db";
import { storableMessage } from "../agent/call-agent.ts";
import { actionSchema } from "../rules/schema.ts";
import { nextFiring } from "../schedule.ts";
import { localTime } from "./schedule-delivery.ts";
import { type DeliverDeps, type Destination, failureReason } from "./deliver.ts";
import { type EmailCap, emailCapRoom, queueCapNoticeOnce, takeEmailCapTurn } from "./email-cap.ts";
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

/** The enabled Digests whose schedule has come, or whose held Destinations can go now. */
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
  const due = new Set(digests.filter((digest) => isDue(digest, now)).map(({ id }) => id));
  // The hosted cap can hold some of a Digest's Destinations, whose Items go when the cap's hold ends. That
  // is usually midnight, before the next firing, so the sweep reads the holds too.
  const released = await db
    .selectDistinct({ id: action.id })
    .from(action)
    .innerJoin(digestItem, eq(digestItem.actionId, action.id))
    .where(and(eq(action.kind, "digest"), eq(action.enabled, true), lte(digestItem.heldUntil, now)));
  for (const { id } of released) due.add(id);
  return [...due];
}

type Sendable = Destination & { type: "telegram" | "email" };

/** One Item of the Digest, as the message lists it, with the Destination it is waiting for. */
interface Collected {
  destinationId: string;
  heldUntil: Date | null;
  id: string;
  title: string | null;
  severity: number | null;
  importance: number | null;
}

/** A Destination this send goes to, the Items it gets, and its reserved `sent_message` row. */
interface Send {
  target: Sendable;
  items: Collected[];
  reservation: string;
}

/** What a claimed send goes out with: a send per Destination, and what waits. */
interface Claim {
  name: string;
  sends: Send[];
  /** The Log's sentences for the Destinations it passes over. */
  skipped: { message: string; data: Record<string, unknown> }[];
  /** The schedule's next time, in words and as an instant, for a send that has to wait for it. */
  next: { at: Date; words: string } | undefined;
}

/**
 * Takes this firing in a short transaction: checks the Digest is due, or that a held Destination's time
 * has come, reads each Destination's Items, records the firing, and counts its messages in
 * `sent_message` before they go, so the hosted cap can't be passed by mail sent while this waits. The
 * Destinations the cap has no room for keep their rows, with the time it ends. Undefined when there's
 * nothing to send.
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
    const firing = isDue({ ...found.action, timezone: settings.timezone }, startedAt);
    // Not a save: the Act stage compares updated_at with an Item's capture.
    const ran = () =>
      tx.update(action).set({ digestRanAt: startedAt, updatedAt: sql`${action.updatedAt}` }).where(eq(action.id, actionId));
    /** Whether the hosted cap's hold on a row has ended. */
    const released = ({ heldUntil }: { heldUntil: Date | null }) => heldUntil !== null && heldUntil <= startedAt;

    // Each Destination's own rows, in the order the message lists them.
    const collected = await tx
      .select({
        destinationId: digestItem.destinationId,
        heldUntil: digestItem.heldUntil,
        id: item.id,
        title: item.title,
        severity: item.severity,
        importance: item.importance,
      })
      .from(digestItem)
      .innerJoin(item, eq(item.id, digestItem.itemId))
      .where(eq(digestItem.actionId, actionId))
      .orderBy(sql`${item.topScore} desc nulls last`, sql`${item.capturedAt} desc`, sql`${item.id} desc`);
    // A hold's end wakes the Digest too, so a Destination the cap held goes before the next firing. When
    // it does, only the rows it held go: Items collected since wait for the next firing, as the others do.
    if (!firing && !collected.some(released)) return undefined;
    if (collected.length === 0) {
      // An empty Digest isn't sent, but its firing still counts as ran.
      if (firing) await ran();
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

    // The Items each Destination gets: all of its rows at a firing, and at a hold's end the rows it held.
    const going = new Map<string, Collected[]>();
    for (const target of confirmed) {
      const rows = collected.filter((row) => row.destinationId === target.id);
      const items = firing ? rows : rows.filter(released);
      if (items.length > 0) going.set(target.id, items);
    }
    let sendable = confirmed.filter((target) => going.has(target.id));

    if (deps.emailCap !== undefined && sendable.some((target) => target.type === "email")) {
      // As many addresses as the local day has room for, in name order, and the rest held until it ends,
      // as this Digest. Telegram isn't counted against the cap, so it goes whatever the day holds. The
      // turn is taken before the count, so two senders can't both take the day's last place.
      await takeEmailCapTurn(tx, settings.id);
      const { room, dayEnd } = await emailCapRoom(tx, settings, startedAt);
      let left = room;
      const sending: Sendable[] = [];
      const held: Sendable[] = [];
      for (const target of sendable) {
        if (target.type === "email" && left === 0) {
          held.push(target);
          continue;
        }
        if (target.type === "email") left -= 1;
        sending.push(target);
      }
      for (const target of held) {
        await tx
          .update(digestItem)
          .set({ heldUntil: dayEnd })
          .where(and(eq(digestItem.actionId, actionId), eq(digestItem.destinationId, target.id)));
      }
      if (held.length > 0) await queueCapNoticeOnce(tx, settings, dayEnd, deps.emailCap);
      sendable = sending;
    }

    if (firing) await ran();
    const sends: Send[] = [];
    for (const target of sendable) {
      const items = going.get(target.id);
      if (items === undefined) continue;
      const [reserved] = await tx
        .insert(sentMessage)
        .values({ workspaceId: settings.id, destinationId: target.id, type: target.type, sentAt: startedAt })
        .returning({ id: sentMessage.id });
      if (reserved !== undefined) sends.push({ target, items, reservation: reserved.id });
    }
    let next: Claim["next"];
    try {
      const at = nextFiring(digest.schedule, startedAt, settings.timezone);
      next = { at, words: `${localTime(at, settings.timezone)} (${settings.timezone})` };
    } catch {
      next = undefined;
    }
    return { name, sends, skipped, next };
  });
}

interface Outcome extends Send {
  error?: unknown;
}

/**
 * Sends a Digest if its schedule has come, or a Destination's held Items if the cap's hold has ended. An
 * empty one sends nothing and writes no Log row. Each Destination's Items go to it as one message and
 * leave the Digest then, so an Item is never in two sends to one Destination. When a send failed and no
 * Destination got the Digest, its Items wait for the next one.
 *
 * No transaction is open during the sends, so an unsubscribe, an edit or a Delivery to the same
 * Destination never waits for a mail server. The firing is claimed before them and recorded after, so a
 * failure in between costs at most one repeat, in the next firing, not one per retry of the job.
 */
export async function sendDigest(db: Db, actionId: string, deps: DigestDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const claimed = await claim(db, actionId, deps, now());
  if (claimed === undefined) return;
  const { name, sends } = claimed;

  const outcomes: Outcome[] = [];
  for (const send of sends) {
    const message = {
      ...groupedAlert(send.items, deps.appUrl),
      digest: name,
      ...(send.target.type === "email" && {
        unsubscribeUrl: unsubscribeUrl(deps.appUrl, deps.secret, actionId, send.target.id),
      }),
    };
    try {
      await deps.senders[send.target.type].send(send.target, message, async (secretCiphertext) => {
        await db.update(destination).set({ secretCiphertext }).where(eq(destination.id, send.target.id));
      });
      outcomes.push(send);
    } catch (error) {
      outcomes.push({ ...send, error });
    }
  }
  await record(db, actionId, claimed, outcomes, now());
}

/**
 * Writes each Item's Log for the Destination it went to, keeps a failed send's error on its Destination
 * and gives back its place in the count, and empties each Destination of the Items it got. A failed
 * Destination's Items leave too when another Destination got them, so the next Digest doesn't repeat them
 * to it. Skipped Destinations are written in the send the Items leave the Digest in, once per Item,
 * rather than at every firing an Item waits through.
 */
async function record(db: Db, actionId: string, claimed: Claim, outcomes: Outcome[], at: Date) {
  const { name, next } = claimed;
  if (outcomes.length === 0) return;
  const anySent = outcomes.some(({ error }) => error === undefined);
  await db.transaction(async (tx) => {
    // Held until the commit, so an Item deleted during the sends doesn't fail its Log's foreign key.
    const present = await tx
      .select({ id: item.id })
      .from(item)
      .where(
        inArray(
          item.id,
          outcomes.flatMap(({ items }) => items.map(({ id }) => id)),
        ),
      )
      .for("key share");
    const there = new Set(present.map(({ id }) => id));
    /** The Log rows for one Destination's send, deduplicated, for the Items still here. */
    const log = async (message: string, data: Record<string, unknown>, items: { id: string }[]) => {
      const ids = [...new Set(items.map(({ id }) => id))].filter((id) => there.has(id));
      if (ids.length === 0) return;
      await tx
        .insert(itemLog)
        .values(ids.map((itemId) => ({ itemId, stage: "act" as const, message: storableMessage(message), data })));
    };
    const drop = (destinationId: string, items: Collected[]) =>
      tx
        .delete(digestItem)
        .where(
          and(
            eq(digestItem.actionId, actionId),
            eq(digestItem.destinationId, destinationId),
            inArray(
              digestItem.itemId,
              items.map(({ id }) => id),
            ),
          ),
        );

    for (const { target, items, reservation, error } of outcomes) {
      const named = { actionId, destinationId: target.id, destination: target.name };
      if (error === undefined) {
        await log(`Sent in the Digest ${name} to ${target.name}`, { ...named, digest: "sent" }, items);
        await tx.update(destination).set({ lastError: null, lastErrorAt: null }).where(eq(destination.id, target.id));
        await drop(target.id, items);
        continue;
      }
      const reason = failureReason(error);
      await tx.delete(sentMessage).where(eq(sentMessage.id, reservation));
      await tx.update(destination).set({ lastError: reason, lastErrorAt: at }).where(eq(destination.id, target.id));
      const failure = `Sending the Digest ${name} to ${target.name} failed: ${reason}`;
      if (anySent) {
        await log(`${failure}. It won't be sent again`, { ...named, digest: "failed", reason, final: true }, items);
        await drop(target.id, items);
      } else if (next === undefined) {
        await log(`${failure}. It waits for the next Digest`, { ...named, final: false }, items);
      } else {
        await log(`${failure}. It waits for the next Digest, at ${next.words}`, { ...named, retryAt: next.at.toISOString() }, items);
      }
    }
    if (!anySent) return;
    const sent = outcomes.flatMap(({ items }) => items);
    for (const { message, data } of claimed.skipped) await log(message, data, sent);
  });
}
