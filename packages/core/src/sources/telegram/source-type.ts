// The Telegram Source type: pushed by the bot runner or a user session's runner, never polled (docs:
// Sources and ingestion, "Source types").
import { z } from "zod";
import type { SourceTypeImpl } from "../types.ts";

const config = z.object({ via: z.enum(["bot", "session"]), chatId: z.number().optional(), title: z.string().optional() });

/** The Bot API can't read history, so only a session Source takes a Backfill. */
const sessionBackfill = { window: 7 * 24 * 60 * 60 * 1000, max: 50 };

export const telegram: SourceTypeImpl = {
  config,
  backfill: (value) => (config.safeParse(value).data?.via === "session" ? sessionBackfill : null),
};
