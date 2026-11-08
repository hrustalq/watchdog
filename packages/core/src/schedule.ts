// The Schedule Trigger: when a Source is next polled (docs: Sources and ingestion, "Scheduling").
import { CronExpressionParser } from "cron-parser";
import type { Config } from "./config.ts";

type Mode = Config["mode"];

export const defaultSchedule = "*/15 * * * *";

// Hosted shares one IP and one worker fleet across every Workspace, so it polls less often.
export const minimumMinutes: Record<Mode, number> = { hosted: 15, "self-hosted": 5 };

const minute = 60 * 1000;
// Enough firings to pass every short gap a cron expression can have. The minute and hour fields
// repeat every day, so the first dense days show the shortest gap, and five years take in a leap
// day for a sparse schedule such as `0 0 29 2 *`.
const firingsChecked = 1000;
const yearsChecked = 5 * 366 * 24 * 60 * minute;

// The worker checks a Source's schedule after every poll, and a check walks up to 1000 firings.
// A Digest's schedule is text a person typed, so neither the entries nor their size can grow with it.
const checked = new Map<string, string | undefined>();
const maxChecked = 1000;
const maxLength = 200;

/**
 * Why a Source or a Digest can't use this cron expression in this mode, or undefined when it can.
 * Without a mode, only whether it is a cron expression at all.
 */
export function scheduleError(schedule: string, mode?: Mode): string | undefined {
  if (schedule.length > maxLength) {
    return `A schedule can be at most ${String(maxLength)} characters.`;
  }
  const key = `${mode ?? "any"} ${schedule}`;
  if (!checked.has(key)) {
    if (checked.size >= maxChecked) checked.clear();
    checked.set(key, findError(schedule.trim(), mode));
  }
  return checked.get(key);
}

function findError(schedule: string, mode: Mode | undefined) {
  try {
    // The parser fills in missing fields, so "* * * *" would pass it.
    const fields = schedule.split(/\s+/).length;
    if (!schedule.startsWith("@") && (fields < 5 || fields > 6)) throw new Error();
    const firings = CronExpressionParser.parse(schedule, { currentDate: new Date(0), tz: "UTC" });
    const first = firings.next().getTime();
    let last = first;
    for (let i = 0; i < firingsChecked && last - first < yearsChecked; i++) {
      const next = firings.next().getTime();
      if (mode !== undefined && next - last < minimumMinutes[mode] * minute) {
        return `A schedule can't run more often than every ${String(minimumMinutes[mode])} minutes on ${mode}.`;
      }
      last = next;
    }
  } catch {
    return `"${schedule}" isn't a cron expression.`;
  }
  return undefined;
}

/**
 * When a Source on this schedule is next polled after `now`: the schedule's next firing plus up to
 * 10% of its interval, at most 60 s, so Sources on one schedule don't all poll in the same second.
 * A schedule the mode refuses polls on the default instead.
 */
export function nextPollAt(schedule: string, mode: Mode, now: Date, random = Math.random): Date {
  const usable = scheduleError(schedule, mode) === undefined ? schedule : defaultSchedule;
  const firings = CronExpressionParser.parse(usable.trim(), { currentDate: now, tz: "UTC" });
  const next = firings.next().getTime();
  const interval = firings.next().getTime() - next;
  return new Date(next + random() * Math.min(interval / 10, minute));
}

const day = 24 * 60 * minute;
const formats = new Map<string, Intl.DateTimeFormat>();

/** How far a timezone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timezone: string) {
  let format = formats.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timezone, format);
  }
  const part = Object.fromEntries(format.formatToParts(instant).map(({ type, value }) => [type, Number(value)]));
  const wall = Date.UTC(part.year ?? 0, (part.month ?? 1) - 1, part.day, part.hour, part.minute, part.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall clock time happens in a timezone: the first of two when the clocks go back, and as
 * Postgres reads it when they go forward past it, moved on by the gap.
 */
function wallToInstant(wall: number, timezone: string) {
  const before = offsetAt(wall - day, timezone);
  const after = offsetAt(wall + day, timezone);
  const valid = [before, after].map((offset) => wall - offset).filter((t) => wall - offsetAt(t, timezone) === t);
  return valid.length > 0 ? Math.min(...valid) : wall - before;
}

/**
 * The schedule's first time after `after`, read in an IANA timezone. cron-parser throws or skips a day
 * when a local time falls in a daylight saving gap, so it walks the wall clock in UTC, which has none,
 * and the wall clock time is turned into an instant here (docs: the cron-parser gotcha page).
 */
export function nextFiring(schedule: string, after: Date, timezone = "UTC"): Date {
  const start = after.getTime();
  const firings = CronExpressionParser.parse(schedule.trim(), {
    currentDate: new Date(start + offsetAt(start, timezone)),
    tz: "UTC",
  });
  for (;;) {
    const instant = wallToInstant(firings.next().getTime(), timezone);
    if (instant > start) return new Date(instant);
  }
}
