import { format } from "date-fns";
import { tz } from "@date-fns/tz";
import { cn } from "@/lib/utils";

const utc = tz("UTC");

/**
 * A UTC time in Data type, as Schedules run in UTC. To the minute, or the second for a Log.
 *
 * The date and the time each stay on one line, so at phone width a date never splits at a hyphen
 * and reads as two values. A line may break only between them, or before or after the whole value.
 */
export function Timestamp({ at, seconds = false, className }: { at: Date; seconds?: boolean; className?: string }) {
  const iso = at.toISOString();
  return (
    <time dateTime={iso} className={cn("font-mono text-[0.8125rem]", className)}>
      <span className="whitespace-nowrap">{format(at, "yyyy-MM-dd", { in: utc })}</span>{" "}
      <span className="whitespace-nowrap">
        {format(at, seconds ? "HH:mm:ss" : "HH:mm", { in: utc })} UTC
      </span>
    </time>
  );
}
