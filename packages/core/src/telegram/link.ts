// The short-lived code that links a Telegram chat to a Destination (docs: Actions and delivery, "Telegram
// chats"; Security and privacy, "Destinations"; ADR 0029). Only its SHA-256 hash is stored.
import { createHash, randomBytes } from "node:crypto";
import { and, type Db, destination, eq, gt, sql, telegramLinkCode } from "@watchdog/db";
import { encryptSecret } from "../secrets/secrets.ts";
import type { BotChat } from "./bot-runner.ts";

export const linkCodeMinutes = 15;

const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");

/** A new code for the Destination, which replaces any earlier one. Base64url is what a deep link can carry. */
export async function issueLinkCode(db: Db, destinationId: string) {
  const code = randomBytes(16).toString("base64url");
  await db.transaction(async (tx) => {
    // Two asking at once would each see nothing to replace, and both codes would live.
    await tx.select({ id: destination.id }).from(destination).where(eq(destination.id, destinationId)).for("update");
    await tx.delete(telegramLinkCode).where(eq(telegramLinkCode.destinationId, destinationId));
    await tx.insert(telegramLinkCode).values({
      codeHash: hashOf(code),
      destinationId,
      expiresAt: sql`now() + make_interval(mins => ${linkCodeMinutes})`,
    });
  });
  return code;
}

/** Which Destination a code still works for, and until when. It spends nothing. */
export async function liveLinkCode(db: Db, code: string) {
  const [live] = await db
    .select({ destinationId: telegramLinkCode.destinationId, expiresAt: telegramLinkCode.expiresAt })
    .from(telegramLinkCode)
    .where(and(eq(telegramLinkCode.codeHash, hashOf(code)), gt(telegramLinkCode.expiresAt, sql`now()`)));
  return live;
}

/**
 * Spends a code on a chat: the Destination holds the chat's id, encrypted, and is confirmed. Gives the
 * Destination's name, or undefined for a code that's unknown, used or expired, or for a Destination
 * already linked, whose chat a late code must not replace.
 */
export function linkChat(db: Db, encryptionKey: Buffer, code: string, chat: BotChat) {
  const liveCode = and(eq(telegramLinkCode.codeHash, hashOf(code)), gt(telegramLinkCode.expiresAt, sql`now()`));
  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ destinationId: telegramLinkCode.destinationId })
      .from(telegramLinkCode)
      .where(liveCode);
    if (found === undefined) return undefined;
    // The Destination's row before the code's, the order removing a Destination takes them through the
    // cascade, so the two can't deadlock.
    const [target] = await tx
      .select({ name: destination.name, confirmedAt: destination.confirmedAt })
      .from(destination)
      .where(eq(destination.id, found.destinationId))
      .for("update");
    const spent = await tx.delete(telegramLinkCode).where(liveCode).returning({ codeHash: telegramLinkCode.codeHash });
    if (target?.confirmedAt !== null || spent.length === 0) return undefined;
    await tx
      .update(destination)
      .set({
        secretCiphertext: encryptSecret(chat.id, encryptionKey),
        // Postgres refuses a NUL in jsonb, and this update would then come back on every poll.
        config: { chat: chat.title.replaceAll("\0", "") },
        confirmedAt: sql`now()`,
      })
      .where(eq(destination.id, found.destinationId));
    return target.name;
  });
}
