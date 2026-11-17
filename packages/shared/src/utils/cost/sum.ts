// Exact addition of costs. The database hands the Usage screen a numeric as text, and every total on
// that screen is added here, so no float ever touches it.
import { Decimal } from "decimal.js";
import type { Cost } from "./types.ts";

/**
 * The canonical spelling of a value: fixed-point, without an exponent or trailing zeros, so
 * "7.5000000000000000" from the database becomes "7.5" and can be compared as a string.
 */
export function toCost(value: Decimal.Value): Cost {
  return new Decimal(value).toFixed();
}

/**
 * A provider's per-token price as the per-million one the Model form stores. Decimal, not a float,
 * because 0.00000015 a token has to become 0.15 a million and not 0.14999999999999999.
 */
export function perMillion(perToken: Decimal.Value): Cost {
  return new Decimal(perToken).times(1_000_000).toFixed();
}

/** The two costs added. Null only when neither recorded one, so a line with no estimate stays null. */
export function addCosts(a: Cost | null, b: Cost | null): Cost | null {
  if (a === null && b === null) return null;
  return new Decimal(a ?? 0)
    .plus(b ?? 0)
    .toFixed();
}
