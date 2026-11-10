// A Source's Health after a poll or push ends (docs: Sources and ingestion, "Source Health").
import type { source } from "@watchdog/db";

type SourceRow = typeof source.$inferSelect;

export type HealthState = Pick<SourceRow, "health" | "consecutiveFailures" | "lastSuccessAt" | "createdAt">;

const degradedAfter = 3;
const failingAfter = 10;
const failingAfterMs = 24 * 60 * 60 * 1000;

/** A failing Source is polled at most this often until it recovers. */
export const failingPollGapMs = 60 * 60 * 1000;

/**
 * The Health columns after an outcome. One success makes a Source ok. Failures count in a row: degraded
 * at 3, failing at 10, or failing at once when nothing has succeeded for 24 hours, counted from the last
 * success or from when the Source was created. A failing Source stays failing until a success.
 */
export function healthAfter(
  state: HealthState,
  outcome: { at: Date; failed: boolean },
): Pick<SourceRow, "health" | "consecutiveFailures" | "lastSuccessAt"> {
  if (!outcome.failed) return { health: "ok", consecutiveFailures: 0, lastSuccessAt: outcome.at };
  const consecutiveFailures = state.consecutiveFailures + 1;
  const since = state.lastSuccessAt ?? state.createdAt;
  const failing =
    state.health === "failing" ||
    consecutiveFailures >= failingAfter ||
    outcome.at.getTime() - since.getTime() >= failingAfterMs;
  const otherwise = consecutiveFailures >= degradedAfter ? "degraded" : "ok";
  return { health: failing ? "failing" : otherwise, consecutiveFailures, lastSuccessAt: state.lastSuccessAt };
}
