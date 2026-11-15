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
  return format(date, withSeconds ? "HH:mm:ss" : "HH:mm", { in: tz(timezone) });
}

function quietHoursEnd(settings: AlertSettings, now: Date) {
  const { quietHoursStart: start, quietHoursEnd: end, timezone } = settings;
  if (start === null || end === null) return undefined;
  // Fixed-width times compare as text. A start after the end is a window across midnight.
  const time = localTime(now, timezone, true);
  const inside = start < end ? time >= start && time < end : start > end && (time >= start || time < end);
  if (!inside) return undefined;
  const [hours = "0", minutes = "0", seconds = "0"] = end.split(":");
  // The end on the local day it falls: today's while it is still ahead, otherwise tomorrow's. It is read
  // as a wall clock and found as an instant by offset, because cron-parser skips a day when the clocks
  // move past it (docs: the cron-parser gotcha page).
  const wall = wallClockAt(now.getTime(), timezone);
  const midnight = startOfDay(new TZDate(wall, "UTC"));
  const endOfDay = set(midnight, {
    hours: Number(hours),
    minutes: Number(minutes),
    seconds: Number(seconds),
    milliseconds: 0,
  });
  const endWall = wall < endOfDay.getTime() ? endOfDay.getTime() : addDays(endOfDay, 1).getTime();
  // A reading the clocks skip ends quiet hours when they land past it, and one they repeat at its first.
  return new Date(wallInstantAtOrAfter(endWall, timezone, now.getTime()));
}

/**
 * What to do with one alert. `recentSends` holds the times of the messages sent to its Destination in
 * the last hour, oldest first, with a Grouped alert as one.
 */
export function scheduleDelivery({
  settings,
  now,
  severity,
  recentSends,
}: {
  settings: AlertSettings;
  now: Date;
  severity: number | null;
  recentSends: Date[];
}): DeliveryDecision {
  const bypasses = settings.severity5BypassesQuietHours && severity === 5;
  const quietEnd = bypasses ? undefined : quietHoursEnd(settings, now);
  if (quietEnd !== undefined) return { kind: "hold", reason: "quiet hours", until: quietEnd };

  const leaving = recentSends[recentSends.length - settings.alertsPerHour];
  if (leaving !== undefined) return { kind: "hold", reason: "rate limit", until: addHours(leaving, 1) };

  const last = recentSends.at(-1);
  const windowEnd = last === undefined ? undefined : addSeconds(last, settings.burstWindowSeconds);
  return windowEnd !== undefined && isAfter(windowEnd, now) ? { kind: "group", until: windowEnd } : { kind: "send" };
}
