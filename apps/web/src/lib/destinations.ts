// A Workspace's Destinations, as the Destinations page reads and changes them. Every query is scoped
// to the Workspace, so another Workspace's Destination id behaves like a missing one.
import { createHash, randomBytes } from "node:crypto";
import { decryptSecret, emailDestinationConfig, encryptSecret, type Mailer, urlIpLiteral } from "@watchdog/core";
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
  inArray,
  isNull,
  itemLog,
  sql,
  type Tx,
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
/** A new link is refused until the last one is this old, so the button can't flood someone's inbox. */
const resendAfter = sql`now() + interval '24 hours' - interval '1 minute'`;

/**
 * Makes a new confirmation link and mails it, replacing any earlier link. Returns "too-soon" when the
 * last one is under a minute old. A mail that fails takes its token with it, so the next try isn't too
 * soon. The mail holds nothing the user typed, because it goes to an address nobody has confirmed.
 */
async function sendConfirmation(db: Db, deps: DestinationDeps, destinationId: string, address: string) {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashOf(token);
  const issued = await db
    .insert(destinationConfirmation)
    .values({ tokenHash, destinationId, expiresAt: linkLifetime })
    .onConflictDoUpdate({
      target: destinationConfirmation.destinationId,
      set: { tokenHash, expiresAt: linkLifetime },
      setWhere: sql`${destinationConfirmation.expiresAt} < ${resendAfter}`,
    })
    .returning({ tokenHash: destinationConfirmation.tokenHash });
  if (issued.length === 0) return "too-soon";

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
    return "sent";
  } catch (error) {
    // The server's own answer goes to the log, because on hosted the mail server is the operator's.
    const answer = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Sending a confirmation mail to Destination ${destinationId} failed: ${answer}\n`);
    await db.delete(destinationConfirmation).where(eq(destinationConfirmation.tokenHash, tokenHash));
    return "failed";
  }
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

  const mail = await sendConfirmation(db, deps, saved.id, address);
  return { destination: saved, mail: mail === "sent" ? "sent" : "failed" } as const;
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
  return sendConfirmation(db, deps, destinationId, parsed.data.address);
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
 * person who owns the address may have no account. False when it's unknown, used or expired.
 */
export function confirmDestination(db: Db, token: string) {
  return db.transaction(async (tx) => {
    const [spent] = await tx
      .delete(destinationConfirmation)
      .where(and(eq(destinationConfirmation.tokenHash, hashOf(token)), gt(destinationConfirmation.expiresAt, sql`now()`)))
      .returning({ destinationId: destinationConfirmation.destinationId });
    if (spent === undefined) return false;
    await tx.update(destination).set({ confirmedAt: sql`now()` }).where(eq(destination.id, spent.destinationId));
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
 * enabled Actions that point only at it. Otherwise it leaves the Actions that used it, whose ids are in
 * `changed`, and a disabled one can be left with none. Undefined when the Workspace has no such Destination.
 *
 * Its Deliveries go with it, because their foreign key would refuse the delete. The Log keeps what was
 * sent, and gets a row for each alert that now never will be.
 */
export async function removeDestination(db: Db, workspaceId: string, destinationId: string) {
  if (!isUuid(destinationId)) return undefined;
  return db.transaction(async (tx) => {
    // The Destination first, as a send holds it, so the two can't deadlock. A send in progress finishes first.
    const [target] = await tx
      .select({ name: destination.name })
      .from(destination)
      .where(and(eq(destination.workspaceId, workspaceId), eq(destination.id, destinationId)))
      .for("update");
    if (target === undefined) return undefined;

    // In a statement of its own, so the check below sees a remove that finished while this one waited.
    // Otherwise two removes could each leave an enabled Action the other Destination, and it would have none.
    const using = await tx
      .select({ id: action.id })
      .from(action)
      .innerJoin(actionDestination, eq(actionDestination.actionId, action.id))
      .where(eq(actionDestination.destinationId, destinationId))
      .for("update", { of: action });
    const refused = await actionsOnlyOn(tx, workspaceId, destinationId);
    if (refused.length > 0) return { refused };

    const changed = using.map(({ id }) => id);
    if (changed.length > 0) {
      await tx
        .update(action)
        .set({
          definition: sql`jsonb_set(${action.definition}, '{destinations}', (${action.definition}->'destinations') - ${destinationId}::text)`,
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

export type DestinationState = "ready" | "confirmed" | "waiting-confirmation" | "waiting-bot" | "unavailable";

function stateOf(type: "telegram" | "email" | "webhook", confirmed: boolean, telegramAvailable: boolean): DestinationState {
  // A webhook has no confirmation step, so the Act stage never treats one as unconfirmed.
  if (type === "webhook") return "ready";
  if (type === "telegram" && !telegramAvailable) return "unavailable";
  if (confirmed) return "confirmed";
  return type === "telegram" ? "waiting-bot" : "waiting-confirmation";
}

/** What a Destination's settings point at: the address or the URL. */
function pointsAt(config: unknown) {
  if (typeof config !== "object" || config === null) return null;
  if ("address" in config && typeof config.address === "string") return config.address;
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
