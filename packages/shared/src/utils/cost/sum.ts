// Exact addition of costs. The database hands the Usage screen a numeric as text, and every total on
// that screen is added here, so no float ever touches it.
import { Decimal } from "decimal.js";
import type { Cost } from "./types.ts";

/** The canonical spelling of a value: fixed-point, without trailing zeros. */
export function toCost(value: Decimal.Value): Cost {
  return new Decimal(value).toFixed();
}

/** The two costs added. Null only when neither recorded one, so a line with no estimate stays null. */
export function addCosts(a: Cost | null, b: Cost | null): Cost | null {
  if (a === null && b === null) return null;
  return new Decimal(a ?? 0)
    .plus(b ?? 0)
    .toFixed();
}
