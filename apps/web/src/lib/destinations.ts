// A Workspace's Destinations, as the Destinations page reads and changes them. Every query is scoped
// to the Workspace, so another Workspace's Destination id behaves like a missing one.
import { createHash, randomBytes } from "node:crypto";
import {
  decryptSecret,
  emailDestinationConfig,
  encryptSecret,
  issueLinkCode,
  liveLinkCode,
  type Mailer,
  sendTestAlert,
  type TestAlertDeps,
  urlIpLiteral,
} from "@watchdog/core";
import {
  action,
  actionDestination,
  and,
  type Db,
  delivery,
  destination,
  destinationConfirmation,
  eq,
  gt,
  healthAlertDestination,
  inArray,
  isNotNull,
  isNull,
  itemLog,
  lte,
  or,
  sql,
  type Tx,
  workspace,
} from "@watchdog/db";
import { isUuid } from "./uuid.ts";

export interface DestinationDeps {
  mailer: Mailer;
  /** The sender of alert mail. This mail goes to an address nobody has confirmed, so it stays off the sign-in sender. */
  alertFrom: string | undefined;
  baseURL: string;
  encryptionKey: Buffer;
  /** The egress guard's policy, so a URL it would always refuse is refused when it's saved. */
  egressAllows: (host: string, address: string) => boolean;
}

/**
 * Why a Destination wasn't saved. A code rather than a sentence, so the form can carry it in its URL
 * without letting a crafted link put words on the page.
 */
export const addProblems = ["blank-name", "duplicate-name", "invalid-address", "invalid-url", "blocked"] as const;
export type AddProblem = (typeof addProblems)[number];

/** What the form says about a problem. */
export function problemMessage(problem: AddProblem, mode: "hosted" | "self-hosted") {
  switch (problem) {
    case "blank-name":
      return "Give it a name. Actions refer to a Destination by name.";
    case "duplicate-name":
      return "This Workspace already has a Destination with that name. Choose another.";
    case "invalid-address":
      return "Enter one email address, such as you@example.com.";
    case "invalid-url":
      return "Enter the full URL, starting with https:// or http://, with no user name or password in it.";
    case "blocked":
      return `That URL is a private, local or non-web address, which Watchdog doesn't call.${mode === "self-hosted" ? " Whoever runs this Watchdog can allow a private address with EGRESS_ALLOWLIST." : ""}`;
  }
}

/** Which form field a problem is about. */
export function problemField(problem: AddProblem) {
  if (problem === "blank-name" || problem === "duplicate-name") return "name";
  return problem === "invalid-address" ? "address" : "url";
}

/** A name on one line, at most 200 characters, without the NUL Postgres text refuses. */
const cleanName = (name: string) => name.replaceAll("\0", "").replace(/\s+/g, " ").trim().slice(0, 200);
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** A confirmation link stays valid this long (docs: Security and privacy, "Destinations"). */
const linkLifetime = sql`now() + interval '24 hours'`;

/**
 * Mails a new confirmation link, which replaces any earlier one, unless the Workspace sent one in the last
 * minute: nothing else stops someone mailing any address again and again from this screen. The mail holds
 * nothing the user typed, because it goes to an address nobody has confirmed.
 */
async function sendConfirmation(
  db: Db,
  deps: DestinationDeps,
  workspaceId: string,
  destinationId: string,
  address: string,
) {
  const claimed = await db
    .update(workspace)
    .set({ confirmationMailAt: sql`now()` })
    .where(
      and(
        eq(workspace.id, workspaceId),
        or(isNull(workspace.confirmationMailAt), lte(workspace.confirmationMailAt, sql`now() - interval '1 minute'`)),
      ),
    )
    .returning({ id: workspace.id });
  if (claimed.length === 0) return "too-soon";

  const token = randomBytes(32).toString("base64url");
  const url = new URL("/destinations/confirm", deps.baseURL);
  url.searchParams.set("token", token);
  try {
    await deps.mailer.send({
      to: address,
      subject: "Confirm this address for Watchdog alerts",
      text: [
        "Someone asked Watchdog to send its alerts to this address. Open this link to confirm it:",
        "",
        url.toString(),
        "",
        "It works once and expires in 24 hours.",
        "If this wasn't you, ignore this email, and Watchdog won't send anything here.",
      ].join("\n"),
      ...(deps.alertFrom !== undefined && { from: deps.alertFrom }),
    });
  } catch (error) {
    // The server's own answer goes to the log, because on hosted the mail server is the operator's.
    const answer = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Sending a confirmation mail to Destination ${destinationId} failed: ${answer}\n`);
    await db.update(workspace).set({ confirmationMailAt: null }).where(eq(workspace.id, workspaceId));
    return "failed";
  }

  // After the mail, so one that fails leaves the link already in someone's inbox working.
  const tokenHash = hashOf(token);
  return db.transaction(async (tx) => {
    // The Destination's row before the confirmation's, the order removing a Destination takes them through
    // the cascade, so the two can't deadlock. Key share, because this changes no key: a send's no-key update
    // runs alongside it, and a remove's update waits. A Destination removed while the mail went leaves no
    // link to keep, and the insert's foreign key would refuse it.
    const [target] = await tx
      .select({ id: destination.id })
      .from(destination)
      .where(eq(destination.id, destinationId))
      .for("key share");
    if (target === undefined) return "sent";
    await tx
      .insert(destinationConfirmation)
      .values({ tokenHash, destinationId, expiresAt: linkLifetime })
      .onConflictDoUpdate({
        target: destinationConfirmation.destinationId,
        set: { tokenHash, expiresAt: linkLifetime },
      });
    return "sent";
  });
}

/**
 * Saves an email Destination. The account's own verified address is confirmed already, because a magic
 * link or a verified OAuth email has proved it. Any other address gets a mail with a link to confirm it.
 */
export async function addEmailDestination(
  db: Db,
  deps: DestinationDeps,
  workspaceId: string,
  account: { email: string; emailVerified: boolean },
  input: { name: string; address: string },
) {
  const name = cleanName(input.name);
  if (name === "") return { problem: "blank-name" } as const;
  const parsed = emailDestinationConfig.safeParse({ address: input.address.trim() });
  if (!parsed.success) return { problem: "invalid-address" } as const;
  const { address } = parsed.data;

  const own = account.emailVerified && address.toLowerCase() === account.email.toLowerCase();
  const [saved] = await db
    .insert(destination)
    .values({ workspaceId, type: "email", name, config: { address }, confirmedAt: own ? sql`now()` : null })
    .onConflictDoNothing()
    .returning({ id: destination.id });
  if (saved === undefined) return { problem: "duplicate-name" } as const;
  if (own) return { destination: saved, mail: "not-needed" } as const;

  return { destination: saved, mail: await sendConfirmation(db, deps, workspaceId, saved.id, address) } as const;
}

/** Sends a waiting email Destination a new link. Anything else in the Workspace is "not-found". */
export async function sendConfirmationAgain(db: Db, deps: DestinationDeps, workspaceId: string, destinationId: string) {
  if (!isUuid(destinationId)) return "not-found";
  const [waiting] = await db
    .select({ config: destination.config })
    .from(destination)
    .where(
      and(
        eq(destination.workspaceId, workspaceId),
        eq(destination.id, destinationId),
        eq(destination.type, "email"),
        isNull(destination.confirmedAt),
      ),
    );
  const parsed = emailDestinationConfig.safeParse(waiting?.config);
  if (!parsed.success) return "not-found";
  return sendConfirmation(db, deps, workspaceId, destinationId, parsed.data.address);
}

/** The address a live confirmation token is for, or undefined. It spends nothing, so a mail scanner can load the page. */
export async function confirmationAddress(db: Db, token: string) {
  const [live] = await db
    .select({ config: destination.config })
    .from(destinationConfirmation)
    .innerJoin(destination, eq(destination.id, destinationConfirmation.destinationId))
    .where(and(eq(destinationConfirmation.tokenHash, hashOf(token)), gt(destinationConfirmation.expiresAt, sql`now()`)));
  const parsed = emailDestinationConfig.safeParse(live?.config);
  return parsed.success ? parsed.data.address : undefined;
}

/**
 * Spends a confirmation token and confirms its Destination. The token alone is the proof, because the
 * person who owns the address may have no account. False when it's unknown, used or expired, and when
 * the Destination was removed as the token was spent.
 */
export function confirmDestination(db: Db, token: string) {
  const tokenHash = hashOf(token);
  const live = and(eq(destinationConfirmation.tokenHash, tokenHash), gt(destinationConfirmation.expiresAt, sql`now()`));
  return db.transaction(async (tx) => {
    // Which Destination it's for, read without locking the token, so a remove can take the Destination
    // first. Then the Destination's row before the token's, the order removing a Destination takes them
    // through the cascade, so the two can't deadlock. A remove that got there first leaves nothing to
    // confirm: its row is gone, and the token with it.
    const [waiting] = await tx
      .select({ destinationId: destinationConfirmation.destinationId })
      .from(destinationConfirmation)
      .where(live);
    if (waiting === undefined) return false;
    const [target] = await tx
      .select({ id: destination.id })
      .from(destination)
      .where(eq(destination.id, waiting.destinationId))
      .for("update");
    if (target === undefined) return false;
    // Spent, and only if this is still the live token: sending the link again replaces it.
    const spent = await tx.delete(destinationConfirmation).where(live).returning({ tokenHash: destinationConfirmation.tokenHash });
    if (spent.length === 0) return false;
    await tx.update(destination).set({ confirmedAt: sql`now()` }).where(eq(destination.id, target.id));
    return true;
  });
}

/** Why a webhook URL can't be saved, or undefined when it can. */
function urlProblem(url: URL | null, egressAllows: DestinationDeps["egressAllows"]) {
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return "invalid-url";
  // fetch refuses a URL with credentials in it, so it could never be called.
  if (url.username !== "" || url.password !== "" || url.href.length > 2048) return "invalid-url";
  const literal = urlIpLiteral(url);
  return literal !== undefined && !egressAllows(literal, literal) ? "blocked" : undefined;
}

/** A webhook secret is 32 random bytes as hex, encrypted at rest (docs: Security and privacy). */
const newSecret = (encryptionKey: Buffer) => encryptSecret(randomBytes(32).toString("hex"), encryptionKey);

/**
 * Saves a webhook Destination with a new secret, for revealWebhookSecret to show once. A host name
 * that resolves to a blocked address is only found when it's called, by the egress guard.
 */
export async function addWebhookDestination(
  db: Db,
  deps: DestinationDeps,
  workspaceId: string,
  input: { name: string; url: string },
) {
  const name = cleanName(input.name);
  if (name === "") return { problem: "blank-name" } as const;
  const url = URL.parse(input.url.trim());
  const problem = urlProblem(url, deps.egressAllows);
  if (problem !== undefined || url === null) return { problem: problem ?? "invalid-url" } as const;

  const [saved] = await db
    .insert(destination)
    .values({
      workspaceId,
      type: "webhook",
      name,
      config: { url: url.href },
      secretCiphertext: newSecret(deps.encryptionKey),
    })
    .onConflictDoNothing()
    .returning({ id: destination.id });
  return saved === undefined ? ({ problem: "duplicate-name" } as const) : { destination: saved };
}

const isWebhook = (workspaceId: string, destinationId: string) =>
  and(eq(destination.workspaceId, workspaceId), eq(destination.id, destinationId), eq(destination.type, "webhook"));

/**
 * The webhook's secret, the first time this is asked and never again. The page calls this while it
 * renders, because it has to work without JavaScript: only a redirect renders a whole page then, so the
 * secret can't come back from the Server Action, and it must not travel in the URL. A render that dies
 * after this loses the secret, which "Replace the secret" gets past.
 */
export async function revealWebhookSecret(db: Db, encryptionKey: Buffer, workspaceId: string, destinationId: string) {
  if (!isUuid(destinationId)) return undefined;
  const [shown] = await db
    .update(destination)
    .set({ secretShownAt: sql`now()` })
    .where(and(isWebhook(workspaceId, destinationId), isNull(destination.secretShownAt)))
    .returning({ ciphertext: destination.secretCiphertext });
  const ciphertext = shown?.ciphertext ?? null;
  return ciphertext === null ? undefined : decryptSecret(ciphertext, encryptionKey);
}

/** Gives the webhook a new secret, for revealWebhookSecret to show once. False when there's no such webhook. */
export async function replaceWebhookSecret(db: Db, encryptionKey: Buffer, workspaceId: string, destinationId: string) {
  if (!isUuid(destinationId)) return false;
  const replaced = await db
    .update(destination)
    .set({ secretCiphertext: newSecret(encryptionKey), secretShownAt: null })
    .where(isWebhook(workspaceId, destinationId))
    .returning({ id: destination.id });
  return replaced.length > 0;
}

/**
 * Sends a test alert to a confirmed Destination, or to a webhook, which needs no confirmation. Undefined
 * for anything else in the Workspace, as an unconfirmed address receives nothing.
 */
export async function testDestination(db: Db, deps: TestAlertDeps, workspaceId: string, destinationId: string) {
  if (!isUuid(destinationId)) return undefined;
  const [target] = await db
    .select()
    .from(destination)
    .where(
      and(
        eq(destination.workspaceId, workspaceId),
        eq(destination.id, destinationId),
        or(eq(destination.type, "webhook"), isNotNull(destination.confirmedAt)),
      ),
    );
  return target && sendTestAlert(db, target, deps);
}

/** The enabled Actions that would have nowhere to deliver without this Destination. */
export async function actionsOnlyOn(reader: Db | Tx, workspaceId: string, destinationId: string) {
  if (!isUuid(destinationId)) return [];
  const rows = await reader
    .select({ name: action.name })
    .from(action)
    .innerJoin(actionDestination, eq(actionDestination.actionId, action.id))
    .where(
      and(
        eq(action.workspaceId, workspaceId),
        eq(action.enabled, true),
        eq(actionDestination.destinationId, destinationId),
        sql`not exists (
          select 1 from ${actionDestination} other
          where other.action_id = ${action.id} and other.destination_id <> ${destinationId}
        )`,
      ),
    )
    .orderBy(action.name);
  return rows.map(({ name }) => name);
}

/** Whether the Health alerts setting names this Destination and no other. */
export async function healthAlertsOnlyOn(reader: Db | Tx, workspaceId: string, destinationId: string) {
  if (!isUuid(destinationId)) return false;
  // Not locked: two removes at once can leave the setting naming none, and then the sign-in address gets them.
  const named = await reader
    .select({ id: healthAlertDestination.destinationId })
    .from(healthAlertDestination)
    .where(eq(healthAlertDestination.workspaceId, workspaceId));
  return named.length === 1 && named[0]?.id === destinationId;
}

/** The names of the Workspace's Actions with these ids. The ids come from a URL, so others are ignored. */
export async function actionNames(db: Db, workspaceId: string, actionIds: string[]) {
  const ids = actionIds.filter(isUuid);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ name: action.name })
    .from(action)
    .where(and(eq(action.workspaceId, workspaceId), inArray(action.id, ids)))
    .orderBy(action.name);
  return rows.map(({ name }) => name);
}

/**
 * Removes a Destination (docs: Actions and delivery, "Deleting a Destination"). `refused` names the
 * enabled Actions that point only at it, and `healthAlerts` says the Health alerts setting names only it.
 * Otherwise it leaves the Actions that used it, whose ids are in `changed`, and the setting, and a
 * disabled Action can be left with none. Undefined when the Workspace has no such Destination.
 *
 * Its Deliveries go with it, because their foreign key would refuse the delete. The Log keeps what was
 * sent, and gets a row for each alert that now never will be.
 */
/** An Action's definition with a Destination taken out of its `destinations`, as an update writes it. */
export const definitionWithout = (destinationId: string) =>
  sql`jsonb_set(${action.definition}, '{destinations}', coalesce(${action.definition}->'destinations', '[]'::jsonb) - ${destinationId}::text)`;

export async function removeDestination(db: Db, workspaceId: string, destinationId: string) {
  if (!isUuid(destinationId)) return undefined;
  return db.transaction(async (tx) => {
    // The Destination first, as a send holds it, so the two can't deadlock. An email or Telegram send in
    // progress finishes first. A webhook call holds no lock, so it can still reach its receiver after this.
    const [target] = await tx
      .select({ name: destination.name })
      .from(destination)
      .where(and(eq(destination.workspaceId, workspaceId), eq(destination.id, destinationId)))
      .for("update");
    if (target === undefined) return undefined;

    // In a statement of its own, so the check below sees a remove that finished while this one waited.
    // Otherwise two removes could each leave an enabled Action the other Destination, and it would have none.
    // No key update, because this changes no key, and the Act stage holds key share on an Action while it
    // waits for that Action's Destinations, which this holds. In id order, so two removes can't deadlock.
    const using = await tx
      .select({ id: action.id })
      .from(action)
      .innerJoin(actionDestination, eq(actionDestination.actionId, action.id))
      .where(eq(actionDestination.destinationId, destinationId))
      .orderBy(action.id)
      .for("no key update", { of: action });
    const refused = await actionsOnlyOn(tx, workspaceId, destinationId);
    const healthAlerts = await healthAlertsOnlyOn(tx, workspaceId, destinationId);
    if (refused.length > 0 || healthAlerts) return { refused, ...(healthAlerts && { healthAlerts }) };

    const changed = using.map(({ id }) => id);
    if (changed.length > 0) {
      await tx
        .update(action)
        .set({
          definition: definitionWithout(destinationId),
          // The Act stage only fires an Action saved before an Item's capture. This isn't a save, and moving
          // the time would silently skip Items already captured and still in the pipeline.
          updatedAt: sql`${action.updatedAt}`,
        })
        .where(inArray(action.id, changed));
    }

    const unsent = await tx
      .select({ itemId: delivery.itemId, actionId: delivery.actionId })
      .from(delivery)
      .where(and(eq(delivery.destinationId, destinationId), inArray(delivery.status, ["queued", "held", "grouped"])));
    if (unsent.length > 0) {
      await tx.insert(itemLog).values(
        unsent.map(({ itemId, actionId }) => ({
          itemId,
          stage: "act" as const,
          message: `Not sent: the Destination ${target.name} was removed`,
          data: { actionId, destinationId, destination: target.name },
        })),
      );
    }

    await tx.delete(delivery).where(eq(delivery.destinationId, destinationId));
    await tx.delete(actionDestination).where(eq(actionDestination.destinationId, destinationId));
    await tx.delete(destination).where(eq(destination.id, destinationId));
    return { changed };
  });
}

/** Saves a Telegram Destination, waiting for the bot, with the first code to send it. */
export async function addTelegramDestination(db: Db, workspaceId: string, input: { name: string }) {
  const name = cleanName(input.name);
  if (name === "") return { problem: "blank-name" } as const;
  const [saved] = await db
    .insert(destination)
    .values({ workspaceId, type: "telegram", name })
    .onConflictDoNothing()
    .returning({ id: destination.id });
  if (saved === undefined) return { problem: "duplicate-name" } as const;
  return { destination: saved, code: await issueLinkCode(db, { destinationId: saved.id }) };
}

/**
 * A new code for a Telegram Destination, or undefined for anything else in the Workspace. A Destination that
 * is confirmed gets one too, so its chat can be replaced: the row stays confirmed and keeps its chat until
 * the code is used, as when the bot was removed from that chat and every send there fails.
 */
export async function newTelegramLink(db: Db, workspaceId: string, destinationId: string) {
  if (!isUuid(destinationId)) return undefined;
  const [target] = await db
    .select({ id: destination.id })
    .from(destination)
    .where(
      and(
        eq(destination.workspaceId, workspaceId),
        eq(destination.id, destinationId),
        eq(destination.type, "telegram"),
      ),
    );
  return target && issueLinkCode(db, { destinationId: target.id });
}

/** Keeps a code in the browser that asked for it, for telegramLinkInCookie. */
export const telegramLinkCookie = "telegram-link";
export const telegramLinkCookieValue = (destinationId: string, code: string) => `${destinationId}.${code}`;

/**
 * What this browser's cookie says about a Telegram link: a code that still works for a Destination, or a
 * Destination that has been linked since. The code stays out of the URL, where history and access logs would
 * keep it, and the database only has its hash, so a cookie is what lets a reload show it again without
 * replacing it. A code asked for on a confirmed Destination shows the panel until it's used, which is how
 * the chat is replaced; after that the code is spent and the Destination is linked again. A render can't
 * clear the cookie, so "linked" lasts as long as the code would have.
 */
export async function telegramLinkInCookie(
  db: Db,
  destinations: { id: string; type: string; name: string; state: DestinationState }[],
  cookie: string | undefined,
) {
  const [destinationId, code] = (cookie ?? "").split(".");
  const row = destinations.find(({ id, type }) => id === destinationId && type === "telegram");
  if (row === undefined || code === undefined) return undefined;
  // An unavailable one has no panel and no control, as a Destination of another type has none.
  if (row.state !== "confirmed" && row.state !== "waiting-bot") return undefined;
  const { id, name } = row;
  const live = await liveLinkCode(db, code);
  if (live?.destinationId === id) return { status: "pending", id, name, code, expiresAt: live.expiresAt } as const;
  return row.state === "confirmed" ? ({ status: "linked", id, name } as const) : undefined;
}

export type DestinationState = "ready" | "confirmed" | "waiting-confirmation" | "waiting-bot" | "unavailable";

function stateOf(type: "telegram" | "email" | "webhook", confirmed: boolean, telegramAvailable: boolean): DestinationState {
  // A webhook has no confirmation step, so the Act stage never treats one as unconfirmed.
  if (type === "webhook") return "ready";
  if (type === "telegram" && !telegramAvailable) return "unavailable";
  if (confirmed) return "confirmed";
  return type === "telegram" ? "waiting-bot" : "waiting-confirmation";
}

/** What a Destination's settings point at: the address, the Telegram chat or the URL. */
function pointsAt(config: unknown) {
  if (typeof config !== "object" || config === null) return null;
  if ("address" in config && typeof config.address === "string") return config.address;
  if ("chat" in config && typeof config.chat === "string") return config.chat;
  return "url" in config && typeof config.url === "string" ? config.url : null;
}

/** The Workspace's Destinations, newest first. No column here holds a credential. */
export async function listDestinations(db: Db, workspaceId: string, { telegramAvailable }: { telegramAvailable: boolean }) {
  const rows = await db.query.destination.findMany({
    where: eq(destination.workspaceId, workspaceId),
    columns: { id: true, type: true, name: true, config: true, confirmedAt: true, lastError: true, lastErrorAt: true },
    orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
  });
  return rows.map(({ config, confirmedAt, ...row }) => ({
    ...row,
    pointsAt: pointsAt(config),
    state: stateOf(row.type, confirmedAt !== null, telegramAvailable),
  }));
}
