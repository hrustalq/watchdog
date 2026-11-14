// The short-lived code that links a Telegram chat to a Destination, or binds one to a Telegram bot Source
// (docs: Actions and delivery, "Telegram chats"; Sources and ingestion, "Telegram bot intake"; Security and
// privacy, "Destinations"; ADR 0029). Only its SHA-256 hash is stored.
import { createHash, randomBytes } from "node:crypto";
import { and, type Db, destination, eq, gt, lt, ne, source, sql, telegramLinkCode } from "@watchdog/db";
import { setPushSourceHealth } from "../delivery/source-alert.ts";
import { encryptSecret } from "../secrets/secrets.ts";
import type { BotChat } from "./bot-runner.ts";

export const linkCodeMinutes = 15;

const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");
const liveCode = (code: string) =>
  and(eq(telegramLinkCode.codeHash, hashOf(code)), gt(telegramLinkCode.expiresAt, sql`now()`));
// Postgres refuses a NUL in jsonb, and the update that brought it would then come back on every poll.
const withoutNul = (title: string) => title.replaceAll("\0", "");

const unknownCode = "That code is unknown or has expired. Get a new link in Watchdog, on the Sources or Destinations page.";

/**
 * Whether the bot's reply is about an unknown or expired code. The bot runner may drop that one when the chat
 * is over its flood limit, because it handles one update at a time and waiting would hold up every other chat.
 * A reply that links the chat is always sent.
 */
export const isUnknownLinkCodeReply = (reply: string) => reply === unknownCode;

type Target = { destinationId: string } | { sourceId: string };

/** A new code for the Destination or Source, which replaces any earlier one. Base64url is what a deep link can carry. */
export async function issueLinkCode(db: Db, target: Target) {
  const code = randomBytes(16).toString("base64url");
  await db.transaction(async (tx) => {
    // Two asking at once would each see nothing to replace, and both codes would live.
    if ("sourceId" in target) {
      await tx.select({ id: source.id }).from(source).where(eq(source.id, target.sourceId)).for("update");
      await tx.delete(telegramLinkCode).where(eq(telegramLinkCode.sourceId, target.sourceId));
    } else {
      await tx.select({ id: destination.id }).from(destination).where(eq(destination.id, target.destinationId)).for("update");
      await tx.delete(telegramLinkCode).where(eq(telegramLinkCode.destinationId, target.destinationId));
    }
    await tx.insert(telegramLinkCode).values({
      codeHash: hashOf(code),
      ...target,
      expiresAt: sql`now() + make_interval(mins => ${linkCodeMinutes})`,
    });
  });
  return code;
}

/**
 * Forgets codes whose time is up. One nobody came back for would otherwise stay forever, and the table
 * has no index to help the deletes by Destination or Source, which scan it: the cascade from a removed
 * one, and the delete `issueLinkCode` makes. The worker's sweep runs this once a minute.
 */
export async function purgeExpiredLinkCodes(db: Db) {
  await db.delete(telegramLinkCode).where(lt(telegramLinkCode.expiresAt, sql`now()`));
}

/** Which Destination or Source a code still works for, and until when. It spends nothing. */
export async function liveLinkCode(db: Db, code: string) {
  const [live] = await db
    .select({
      destinationId: telegramLinkCode.destinationId,
      sourceId: telegramLinkCode.sourceId,
      expiresAt: telegramLinkCode.expiresAt,
    })
    .from(telegramLinkCode)
    .where(liveCode(code));
  return live;
}

/** Spends a code on the chat it came from, and gives the bot's reply there. */
export async function linkChat(db: Db, encryptionKey: Buffer, code: string, chat: BotChat) {
  const { sourceId = null, destinationId = null } = (await liveLinkCode(db, code)) ?? {};
  if (sourceId !== null) return bindSource(db, code, sourceId, chat);
  const name = destinationId === null ? undefined : await linkDestination(db, encryptionKey, code, destinationId, chat);
  return name === undefined ? unknownCode : `Linked to ${name} in Watchdog`;
}

/**
 * The Destination holds the chat's id, encrypted, and is confirmed. Gives the Destination's name, or
 * undefined for a code used or expired meanwhile, or for a Destination already linked, whose chat a late
 * code must not replace.
 */
function linkDestination(db: Db, encryptionKey: Buffer, code: string, destinationId: string, chat: BotChat) {
  return db.transaction(async (tx) => {
    // The Destination's row before the code's, the order removing a Destination takes them through the
    // cascade, so the two can't deadlock.
    const [target] = await tx
      .select({ name: destination.name, confirmedAt: destination.confirmedAt })
      .from(destination)
      .where(eq(destination.id, destinationId))
      .for("update");
    const spent = await tx.delete(telegramLinkCode).where(liveCode(code)).returning({ codeHash: telegramLinkCode.codeHash });
    if (target?.confirmedAt !== null || spent.length === 0) return undefined;
    await tx
      .update(destination)
      .set({
        secretCiphertext: encryptSecret(chat.id, encryptionKey),
        config: { chat: withoutNul(chat.title) },
        confirmedAt: sql`now()`,
      })
      .where(eq(destination.id, destinationId));
    return target.name;
  });
}

/**
 * The Source watches the chat from now on, and is ok again if it had lost access. A private chat spends
 * nothing, so the same link still works in a group. A chat the Workspace already watches spends the code,
 * because everyone there saw it.
 */
function bindSource(db: Db, code: string, sourceId: string, chat: BotChat) {
  if (chat.type === "private") {
    return "A private chat can't be a Source. Use the link to add the bot to a group, or post the command in a channel where the bot is an admin.";
  }
  return db.transaction(async (tx) => {
    // The Source's row before the code's, as for a Destination.
    const [target] = await tx
      .select({ name: source.name, workspaceId: source.workspaceId })
      .from(source)
      .where(eq(source.id, sourceId))
      .for("update");
    if (target === undefined) return unknownCode;
    const [watching] = await tx
      .select({ name: source.name })
      .from(source)
      .where(
        and(
          eq(source.workspaceId, target.workspaceId),
          eq(source.type, "telegram"),
          eq(source.dedupKey, chat.id),
          ne(source.id, sourceId),
        ),
      );
    const spent = await tx.delete(telegramLinkCode).where(liveCode(code)).returning({ codeHash: telegramLinkCode.codeHash });
    if (spent.length === 0) return unknownCode;
    if (watching !== undefined) return `This chat is already watched by ${watching.name} in Watchdog`;
    await tx
      .update(source)
      .set({ config: { via: "bot", chatId: Number(chat.id), title: withoutNul(chat.title) } })
      .where(eq(source.id, sourceId));
    // Bound again after the bot lost its chat, the Source has its access back, and says so.
    await setPushSourceHealth(tx, eq(source.id, sourceId), null);
    return `Watching this chat for ${target.name} in Watchdog`;
  });
}
