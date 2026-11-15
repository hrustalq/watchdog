// Whether an alert can go now (docs: Actions and delivery, "Grouping and rate limits" and "Quiet hours").
// Decided when it's due to send, from the settings as they are then (ADR 0028).
import { addDays, addHours, addSeconds, format, isAfter, set, startOfDay } from "date-fns";
import { tz, TZDate } from "@date-fns/tz";
import { wallClockAt, wallInstantAtOrAfter } from "../timezone.ts";

export interface AlertSettings {
  /** An IANA name, in which quiet hours are read. */
  timezone: string;
  /** Local times as Postgres writes them, `HH:MM:SS`. Both null when quiet hours are off. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  severity5BypassesQuietHours: boolean;
  alertsPerHour: number;
  burstWindowSeconds: number;
}

export type DeliveryDecision =
  | { kind: "send" }
  | { kind: "hold"; reason: "quiet hours" | "rate limit"; until: Date }
  | { kind: "group"; until: Date };

/** What a strategy decides from: the settings in force, the alert, and the sends before it. */
export interface DeliveryRequest {
  settings: AlertSettings;
  now: Date;
  severity: number | null;
  recentSends: Date[];
}

/** One strategy in the chain. A decision ends the search; undefined lets the alert through it. */
interface DeliveryStrategy {
  decide(request: DeliveryRequest): DeliveryDecision | undefined;
}

/** A quiet-hours window: whether a wall clock reading falls inside it. */
interface QuietWindow {
  contains(time: string, start: string, end: string): boolean;
}

/** Quiet hours that start and end on the same local day. */
const sameDayWindow: QuietWindow = {
  contains: (time, start, end) => time >= start && time < end,
};

/** Quiet hours that run across midnight. */
const overnightWindow: QuietWindow = {
  contains: (time, start, end) => time >= start || time < end,
};

/** Quiet hours whose start and end are the same reading: a window that is always empty. */
const emptyWindow: QuietWindow = {
  contains: () => false,
};

/** The window a start and end describe: across midnight when the end is before the start. */
function quietWindow(start: string, end: string): QuietWindow {
  if (start < end) return sameDayWindow;
  if (start > end) return overnightWindow;
  return emptyWindow;
}

/** The date-fns pattern for a wall clock: to the minute, or to the second for a Log. */
function clockPattern(withSeconds: boolean) {
  return withSeconds ? "HH:mm:ss" : "HH:mm";
}

/**
 * A date, a time and the zone, so the Log and Item detail's Actions section write a hold or a retry the
 * same way: `2026-11-07 23:59 Europe/Berlin`. The date matters because a hold can run past midnight,
 * and the zone because the rest of the page reads in UTC.
 */
export function localDateTime(date: Date, timezone: string) {
  return `${format(date, "yyyy-MM-dd HH:mm", { in: tz(timezone) })} ${timezone}`;
}

/** A wall clock in a timezone, to the minute or to the second. */
export function localTime(date: Date, timezone: string, withSeconds = false) {
  return format(date, clockPattern(withSeconds), { in: tz(timezone) });
}

/** The wall clock of quiet hours' end on the local day it next falls: today's or tomorrow's. */
function quietEndWall(wall: number, endOfDay: Date) {
  if (wall < endOfDay.getTime()) return endOfDay.getTime();
  return addDays(endOfDay, 1).getTime();
}

/** The end of quiet hours when they are on and `now` falls inside them. */
function quietHoursEnd(settings: AlertSettings, now: Date) {
  const { quietHoursStart: start, quietHoursEnd: end, timezone } = settings;
  if (start === null || end === null) return undefined;
  // Fixed-width times compare as text.
  const time = localTime(now, timezone, true);
  const window = quietWindow(start, end);
  if (!window.contains(time, start, end)) return undefined;
  const [hours = "0", minutes = "0", seconds = "0"] = end.split(":");
  // The end on the local day it falls: it is read as a wall clock and found as an instant by offset,
  // because cron-parser skips a day when the clocks move past it (docs: the cron-parser gotcha page).
  const wall = wallClockAt(now.getTime(), timezone);
  const midnight = startOfDay(new TZDate(wall, "UTC"));
  const endOfDay = set(midnight, {
    hours: Number(hours),
    minutes: Number(minutes),
    seconds: Number(seconds),
    milliseconds: 0,
  });
  // A reading the clocks skip ends quiet hours when they land past it, and one they repeat at its first.
  return new Date(wallInstantAtOrAfter(quietEndWall(wall, endOfDay), timezone, now.getTime()));
}

/** Holds an alert inside quiet hours, unless its severity is one that may go through them. */
const quietHoursStrategy: DeliveryStrategy = {
  decide({ settings, now, severity }) {
    const bypasses = settings.severity5BypassesQuietHours && severity === 5;
    if (bypasses) return undefined;
    const until = quietHoursEnd(settings, now);
    if (until === undefined) return undefined;
    return { kind: "hold", reason: "quiet hours", until };
  },
};

/** Holds an alert past the hourly limit until the oldest send leaves the hour. */
const rateLimitStrategy: DeliveryStrategy = {
  decide({ settings, recentSends }) {
    const leaving = recentSends[recentSends.length - settings.alertsPerHour];
    if (leaving === undefined) return undefined;
    return { kind: "hold", reason: "rate limit", until: addHours(leaving, 1) };
  },
};

/** Groups an alert until the burst window after the last send closes. */
const burstStrategy: DeliveryStrategy = {
  decide({ settings, now, recentSends }) {
    const last = recentSends.at(-1);
    if (last === undefined) return undefined;
    const until = addSeconds(last, settings.burstWindowSeconds);
    if (!isAfter(until, now)) return undefined;
    return { kind: "group", until };
  },
};

/** The strategies in the order they decide: quiet hours, then the rate limit, then the burst window. */
const deliveryStrategies: readonly DeliveryStrategy[] = [quietHoursStrategy, rateLimitStrategy, burstStrategy];

/**
 * What to do with one alert. `recentSends` holds the times of the messages sent to its Destination in
 * the last hour, oldest first, with a Grouped alert as one.
 */
export function scheduleDelivery(request: DeliveryRequest): DeliveryDecision {
  for (const strategy of deliveryStrategies) {
    const decision = strategy.decide(request);
    if (decision !== undefined) return decision;
  }
  return { kind: "send" };
}
