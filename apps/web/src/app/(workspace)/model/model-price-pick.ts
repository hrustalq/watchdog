import type { ListedModel } from "@watchdog/core";

/**
 * The prices a pick fills in, or undefined when it must not: a provider that publishes none has
 * nothing to offer, and a field that already holds a number was typed, so a detection never
 * replaces it by itself (GitHub issue #489).
 */
export function pickPrefill(
  model: ListedModel | undefined,
  held: { inputPrice: string; outputPrice: string },
): { inputPrice: string; outputPrice: string } | undefined {
  if (model === undefined) return undefined;
  if (model.inputPricePerMillion === null || model.outputPricePerMillion === null) return undefined;
  if (held.inputPrice !== "" || held.outputPrice !== "") return undefined;
  return { inputPrice: String(model.inputPricePerMillion), outputPrice: String(model.outputPricePerMillion) };
}
