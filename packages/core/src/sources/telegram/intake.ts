// What the bot runner hands on that isn't a code: messages become Items in every Source bound to their
// chat, and the bot losing its place in a chat makes those Sources failing (docs: Sources and ingestion,
// "Telegram bot intake" and "Source Health").
import { and, type Db, eq, source, sql } from "@watchdog/db";
import { setPushSourceHealth } from "../../delivery/source-alert.ts";
import { captureItems, type CaptureDeps } from "../../pipeline/capture.ts";
import type { BotUpdate, ChatMemberUpdate } from "../../telegram/update.ts";
import { telegramDraft } from "./draft.ts";

/** The bot Sources bound to the chat, in every Workspace. A session Source of the same chat isn't one. */
const boundTo = (chatId: number) =>
  and(eq(source.type, "telegram"), eq(source.dedupKey, String(chatId)), sql`${source.config}->>'via' = 'bot'`);

/** The runner's `intake`: one update at a time, so a failure retries or skips only that update. */
export function telegramIntake(db: Db, deps: CaptureDeps) {
  return async ({ message, channel_post: post = message, my_chat_member: member }: BotUpdate) => {
    const at = deps.now?.() ?? new Date();
    if (post?.migrate_to_chat_id !== undefined) {
      // The group's last message: it is a supergroup now, with a new id, so its Sources follow it. A
      // Workspace that already watches the supergroup keeps its old Source, so the move can't break the key.
      const to = post.migrate_to_chat_id;
      const watchesIt = sql`exists (select 1 from source s where s.workspace_id = ${source.workspaceId}
        and s.type = 'telegram' and s.dedup_key = ${String(to)})`;
      await db
        .update(source)
        .set({ config: sql`jsonb_set(${source.config}, '{chatId}', to_jsonb(${to}::bigint))` })
        .where(and(boundTo(post.chat.id), sql`not ${watchesIt}`));
      return;
    }
    const draft = post && telegramDraft(post);
    if (post !== undefined && draft !== undefined) {
      const bound = await db.select({ id: source.id }).from(source).where(boundTo(post.chat.id));
      for (const { id } of bound) await captureItems(db, id, [draft], { at, polled: false }, deps);
    }
    if (member === undefined) return;
    // The bot back in the chat, through a new link or not, is access returned.
    const lost = lostAccess(member) ?? null;
    await db.transaction((tx) => setPushSourceHealth(tx, boundTo(member.chat.id), lost, at));
  };
}

/** Why the bot can't read the chat any more, or undefined while it still can. */
function lostAccess({ chat, new_chat_member: { status, is_member: isMember } }: ChatMemberUpdate) {
  const again = " Add the bot back to the chat, or bind the chat again with a new link from this Source.";
  if (status === "kicked") return `The bot was removed from this chat and banned from it.${again}`;
  if (status === "left" || (status === "restricted" && isMember === false)) {
    return `The bot was removed from this chat, or left it.${again}`;
  }
  // A bot reads a channel's posts only as one of its admins.
  if (chat.type === "channel" && status !== "administrator" && status !== "creator") {
    return "The bot is no longer an admin of this channel, so it can't read the posts. Make it an admin again, or bind the channel again with a new link from this Source.";
  }
  return undefined;
}
