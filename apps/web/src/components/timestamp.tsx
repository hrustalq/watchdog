import { cn } from "@/lib/utils";

/** A UTC time in Data type, as Schedules run in UTC. To the minute, or the second for a Log. */
export function Timestamp({ at, seconds = false, className }: { at: Date; seconds?: boolean; className?: string }) {
  return (
    <time dateTime={at.toISOString()} className={cn("font-mono text-[0.8125rem]", className)}>
      {at.toISOString().slice(0, seconds ? 19 : 16).replace("T", " ")} UTC
    </time>
  );
}
