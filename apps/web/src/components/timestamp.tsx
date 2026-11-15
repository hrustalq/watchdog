import { format } from "date-fns";
import { tz } from "@date-fns/tz";
import { cn } from "@/lib/utils";

const utc = tz("UTC");

/** The time format a Timestamp uses: to the minute, or to the second for a Log. */
function timePattern(seconds: boolean) {
  return seconds ? "HH:mm:ss" : "HH:mm";
}

/**
 * A UTC time in Data type, as Schedules run in UTC. To the minute, or to the second for a Log.
 *
 * The date and the time each stay on one line, so at phone width a date never splits at a hyphen
 * and reads as two values. A line may break only between them, or before or after the whole value.
 */
export function Timestamp({ at, seconds = false, className }: { at: Date; seconds?: boolean; className?: string }) {
  const iso = at.toISOString();
  const date = format(at, "yyyy-MM-dd", { in: utc });
  const time = format(at, timePattern(seconds), { in: utc });
  return (
    <time dateTime={iso} className={cn("font-mono text-[0.8125rem]", className)}>
      <span className="whitespace-nowrap">{date}</span>{" "}
      <span className="whitespace-nowrap">{time} UTC</span>
    </time>
  );
}
