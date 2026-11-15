import { Decimal } from "decimal.js";
import type { Cost } from "./types.ts";

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Below this, four decimals would print a zero that reads as nothing. */
const smallestShown = new Decimal("0.0001");

/**
 * A cost as the Usage screen prints it: four decimals, en-US grouping, no currency, and anything
 * under 0.0001 as "<0.0001" rather than a zero that reads as nothing.
 */
export function formatCost(cost: Cost): string {
  const value = new Decimal(cost);
  if (value.gt(0) && value.lt(smallestShown)) return "<0.0001";
  const [whole = "0", fraction = "0000"] = value.toFixed(4).split(".");
  return `${group(whole)}.${fraction}`;
}
