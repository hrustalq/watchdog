import { cn } from "@/lib/utils";

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
      <span className="whitespace-nowrap">{iso.slice(0, 10)}</span>{" "}
      <span className="whitespace-nowrap">
        {iso.slice(11, seconds ? 19 : 16)} UTC
      </span>
    </time>
  );
}
