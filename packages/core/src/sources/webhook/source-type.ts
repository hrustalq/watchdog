// The webhook inbox Source type: pushed, never polled, with no Backfill (docs: Sources and ingestion,
// "Webhook inbox").
import { z } from "zod";
import type { SourceTypeImpl } from "../types.ts";

const path = z.string().optional();

export const webhookConfig = z.object({
  mapping: z.object({ title: path, body: path, url: path, externalId: path }).optional(),
});

export const webhook: SourceTypeImpl = { config: webhookConfig, backfill: null };
