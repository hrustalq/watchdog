// The wall clock in an IANA timezone, and the instant a wall clock reading happens (docs: the
// cron-parser gotcha page). A wall clock is milliseconds since 1970 as if UTC read the same numbers.
import { tzOffset } from "@date-fns/tz";

const day = 24 * 60 * 60 * 1000;
const minute = 60 * 1000;

/**
 * How far a timezone's wall clock is ahead of UTC at an instant, in milliseconds. `tzOffset` reads
 * the second it lands in, so a reading the clocks repeat takes the offset it has then.
 */
export function offsetAt(instant: number, timezone: string) {
  return tzOffset(timezone, new Date(instant)) * minute;
}

/** What the wall clock in `timezone` reads at an instant, to the second. */
export function wallClockAt(instant: number, timezone: string) {
  return Math.floor(instant / 1000) * 1000 + offsetAt(instant, timezone);
}

/**
 * Every instant whose wall clock in `timezone` reads `wall`: two when the clocks go back over that
 * reading, and none when they go forward past it.
 */
export function wallInstants(wall: number, timezone: string) {
  return [offsetAt(wall - day, timezone), offsetAt(wall + day, timezone)]
    .map((offset) => wall - offset)
    .filter((instant) => wall - offsetAt(instant, timezone) === instant);
}

/**
 * The instant a wall clock reading happens in a timezone: the first of two when the clocks go back, and
 * as Postgres reads it when they go forward past it, moved on by the gap.
 */
export function wallToInstant(wall: number, timezone: string) {
  const instants = wallInstants(wall, timezone);
  if (instants.length > 0) return Math.min(...instants);
  return wall - offsetAt(wall - day, timezone);
}

const step = 15 * 60 * 1000;
const reach = 15 * 60 * 60 * 1000;

/**
 * The first instant at or after `from` whose wall clock in `timezone` reads `wall` or later: the first
 * of two when the clocks repeat that reading, and where they land when they skip it.
 */
export function wallInstantAtOrAfter(wall: number, timezone: string, from: number) {
  const instants = wallInstants(wall, timezone).filter((instant) => instant > from);
  if (instants.length > 0) return Math.min(...instants);
  // The clocks skipped this reading, so they jump from before it to after it. Walk to where they have
  // passed it, then halve the last step down to the second. A zone is never more than 14 hours from
  // UTC, so 15 hours back is a reading that is still before `wall`.
  let before = Math.max(from, wall - reach);
  let after = before + step;
  while (wallClockAt(after, timezone) < wall && after < wall + reach) {
    before = after;
    after += step;
  }
  while (after - before > 1000) {
    const middle = before + Math.floor((after - before) / 2000) * 1000;
    if (wallClockAt(middle, timezone) >= wall) after = middle;
    else before = middle;
  }
  return after;
}
