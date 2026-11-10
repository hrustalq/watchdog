// The parts of a Bot API update that Watchdog reads (https://core.telegram.org/bots/api#update). Each
// object is loose, so a message keeps every field for an Item's `raw`.
import { z } from "zod";

const chat = z.looseObject({
  id: z.number(),
  type: z.string(),
  title: z.string().optional(),
  username: z.string().optional(),
});

export const botMessage = z.looseObject({
  message_id: z.number(),
  date: z.number(),
  chat,
  from: z.looseObject({ first_name: z.string(), last_name: z.string().optional() }).optional().catch(undefined),
  author_signature: z.string().optional().catch(undefined),
  text: z.string().optional().catch(undefined),
  caption: z.string().optional().catch(undefined),
  /** Set on the last message of a group that became a supergroup, the new chat's id. */
  migrate_to_chat_id: z.number().optional().catch(undefined),
});
export type BotMessage = z.output<typeof botMessage>;

const chatMember = z.looseObject({
  chat,
  new_chat_member: z.looseObject({ status: z.string() }),
});
export type ChatMemberUpdate = z.output<typeof chatMember>;

/** An update of a kind Watchdog doesn't read, or a part it can't parse, comes through as undefined. */
export const botUpdate = z.object({
  update_id: z.number(),
  message: botMessage.optional().catch(undefined),
  channel_post: botMessage.optional().catch(undefined),
  my_chat_member: chatMember.optional().catch(undefined),
});
export type BotUpdate = z.output<typeof botUpdate>;
