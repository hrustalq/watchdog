// Whether an alert can go now (docs: Actions and delivery, "Grouping and rate limits" and "Quiet hours").
// Decided when it's due to send, from the settings as they are then (ADR 0028).
import { CronExpressionParser } from "cron-parser";

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

const hourMs = 60 * 60 * 1000;

/** A wall clock in a timezone, to the minute or to the second. */
export function localTime(date: Date, timezone: string, withSeconds = false) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  }).format(date);
}

function quietHoursEnd(settings: AlertSettings, now: Date) {
  const { quietHoursStart: start, quietHoursEnd: end, timezone } = settings;
  if (start === null || end === null) return undefined;
  // Fixed-width times compare as text. A start after the end is a window across midnight.
  const time = localTime(now, timezone, true);
  const inside = start < end ? time >= start && time < end : start > end && (time >= start || time < end);
  if (!inside) return undefined;
  const [hours, minutes, seconds] = end.slice(0, 8).split(":");
  return CronExpressionParser.parse(`${String(seconds)} ${String(minutes)} ${String(hours)} * * *`, {
    currentDate: now,
    tz: timezone,
  })
    .next()
    .toDate();
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
  if (leaving !== undefined) return { kind: "hold", reason: "rate limit", until: new Date(leaving.getTime() + hourMs) };

  const last = recentSends.at(-1);
  const windowEnd = last === undefined ? 0 : last.getTime() + settings.burstWindowSeconds * 1000;
  return windowEnd > now.getTime() ? { kind: "group", until: new Date(windowEnd) } : { kind: "send" };
}
