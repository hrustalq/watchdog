import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { monthLabel } from "@/lib/usage";
import { cn } from "@/lib/utils";

/** The month's URL. The current month has none of its own, so a saved link keeps following it. */
const monthHref = (month: string, current: string) => (month === current ? "/usage" : `/usage?month=${month}`);

/**
 * Both directions take this width and a missing one leaves an empty slot of it, so a link never moves
 * as the months change: with the newer link gone, the older one isn't the rightmost and clicking its
 * spot again doesn't land on the newer link that would replace it. Wide enough for "← September
 * 2026", the longest label, so a label's length can't widen its slot either.
 */
const slot = "w-42";

/**
 * The Usage screen's month links, older on the left and newer on the right. A direction with nothing
 * to go to keeps its empty slot and renders no control, so it takes no tab stop.
 */
export function MonthNav({
  current,
  older,
  newer,
}: {
  /** The month the screen shows, whose own link is `/usage` rather than a month. */
  current: string;
  older: string | undefined;
  newer: string | undefined;
}) {
  if (older === undefined && newer === undefined) return null;
  return (
    <nav aria-label="Month" className="flex flex-wrap gap-2">
      {older === undefined ? (
        <span aria-hidden="true" className={slot} />
      ) : (
        <Link href={monthHref(older, current)} className={cn(buttonVariants({ variant: "outline" }), slot)}>
          <span aria-hidden="true">←</span> {monthLabel(older)}
        </Link>
      )}
      {newer === undefined ? (
        <span aria-hidden="true" className={slot} />
      ) : (
        <Link href={monthHref(newer, current)} className={cn(buttonVariants({ variant: "outline" }), slot)}>
          {monthLabel(newer)} <span aria-hidden="true">→</span>
        </Link>
      )}
    </nav>
  );
}
