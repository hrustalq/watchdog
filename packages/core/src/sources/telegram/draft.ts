// A message the bot reads in a chat, as a draft (docs: Sources and ingestion, "Telegram bot intake").
import type { BotMessage } from "../../telegram/update.ts";
import { capBody, type ItemDraft, tidyText } from "../item.ts";

const maxTitle = 200;
/** A bot command, such as `/start@bot <code>`, is for a bot, not news. */
const command = /^\/\w/;

/** The draft for a message with text or a caption, or undefined for anything else. */
export function telegramDraft(message: BotMessage): ItemDraft | undefined {
  const text = tidyText(message.text ?? message.caption ?? "");
  if (text === "" || command.test(text)) return undefined;
  const { chat, message_id: id, from } = message;
  const author = from === undefined ? message.author_signature : [from.first_name, from.last_name].filter(Boolean).join(" ");
  return {
    externalId: `${String(chat.id)}:${String(id)}`,
    url: messageUrl(chat, id),
    title: (text.split("\n")[0] ?? "").slice(0, maxTitle),
    author: author ?? null,
    body: capBody(text),
    publishedAt: new Date(message.date * 1000),
    raw: message,
  };
}

/** A public chat's link by username, a private supergroup's or channel's by id; a basic group has none. */
function messageUrl({ id, username }: BotMessage["chat"], messageId: number) {
  if (username !== undefined) return `https://t.me/${username}/${String(messageId)}`;
  const internal = /^-100(\d+)$/.exec(String(id))?.[1];
  return internal === undefined ? null : `https://t.me/c/${internal}/${String(messageId)}`;
}
