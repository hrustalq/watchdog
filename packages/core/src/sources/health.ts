// A Source's Health after a poll or push ends (docs: Sources and ingestion, "Source Health").
import { differenceInHours } from "date-fns";
import type { source } from "@watchdog/db";

type SourceRow = typeof source.$inferSelect;

export type HealthState = Pick<SourceRow, "health" | "consecutiveFailures" | "lastSuccessAt" | "createdAt">;

const degradedAfter = 3;
const failingAfter = 10;
const failingAfterHours = 24;
/** Failures in a row before the 24 hours with no success count. */
const failingAfterHoursFrom = 2;

/** A failing Source is polled at most this often until it recovers. */
export const failingPollGapMs = 60 * 60 * 1000;

/** Whether failed polls have gone on for a day, counted from the last success or from creation. */
function failingForADay(consecutiveFailures: number, at: Date, since: Date) {
  return consecutiveFailures >= failingAfterHoursFrom && differenceInHours(at, since) >= failingAfterHours;
}

/** The Health after another failure: a failing Source stays failing until a success. */
function failedHealth(state: HealthState, consecutiveFailures: number, at: Date): SourceRow["health"] {
  const since = state.lastSuccessAt ?? state.createdAt;
  const failing =
    state.health === "failing" ||
    consecutiveFailures >= failingAfter ||
    failingForADay(consecutiveFailures, at, since);
  if (failing) return "failing";
  if (consecutiveFailures >= degradedAfter) return "degraded";
  return "ok";
}

/**
 * The Health columns after an outcome. One success makes a Source ok. Failures count in a row: degraded
 * at 3, failing at 10, or failing from the second failed poll in a row when nothing has succeeded for
 * 24 hours, counted from the last success or from when the Source was created. Needing the second keeps
 * one transient error from making a daily or slower Source failing. A failing Source stays failing until a success.
 */
export function healthAfter(
  state: HealthState,
  outcome: { at: Date; failed: boolean },
): Pick<SourceRow, "health" | "consecutiveFailures" | "lastSuccessAt"> {
  if (!outcome.failed) return { health: "ok", consecutiveFailures: 0, lastSuccessAt: outcome.at };
  const consecutiveFailures = state.consecutiveFailures + 1;
  return {
    health: failedHealth(state, consecutiveFailures, outcome.at),
    consecutiveFailures,
    lastSuccessAt: state.lastSuccessAt,
  };
}
