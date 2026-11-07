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
 * Spends a code on a chat: the Destination holds the chat's id, encrypted, and is confirmed. The earlier
 * failures are about having no chat, so they go. Gives the Destination's name, or undefined for a code
 * that's unknown, used or expired.
 */
export function linkChat(db: Db, encryptionKey: Buffer, code: string, chat: BotChat) {
  return db.transaction(async (tx) => {
    const [spent] = await tx
      .delete(telegramLinkCode)
      .where(and(eq(telegramLinkCode.codeHash, hashOf(code)), gt(telegramLinkCode.expiresAt, sql`now()`)))
      .returning({ destinationId: telegramLinkCode.destinationId });
    if (spent === undefined) return undefined;
    const [linked] = await tx
      .update(destination)
      .set({
        secretCiphertext: encryptSecret(chat.id, encryptionKey),
        config: { chat: chat.title },
        confirmedAt: sql`now()`,
        lastError: null,
        lastErrorAt: null,
      })
      .where(eq(destination.id, spent.destinationId))
      .returning({ name: destination.name });
    return linked?.name;
  });
}
