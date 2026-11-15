import { cn } from "@/lib/utils";

const summary =
  "inline-flex h-8 cursor-pointer list-none items-center rounded-lg px-3 text-sm font-medium outline-hidden select-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/60 group-open:bg-muted dark:hover:bg-muted/50 [&::-webkit-details-marker]:hidden";

/**
 * A native disclosure whose summary is a 32px control, so a confirmation or a small form opens and
 * closes without JavaScript. `label` is the closed summary and `openLabel` the one that takes over
 * while it's open; a caller that needs a name for a screen reader puts its `sr-only` text inside
 * them. `bodyClassName` is the surface under it: a destructive confirmation sits on a card, not the
 * Instrument Well, where Alarm Red on the tint would fall under 4.5:1 (DESIGN.md → Buttons).
 */
export function Disclosure({
  label,
  openLabel,
  open,
  className,
  bodyClassName,
  children,
}: {
  label: React.ReactNode;
  openLabel: React.ReactNode;
  open?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <details open={open} className={cn("group", className)}>
      <summary className={summary}>
        <span className="group-open:hidden">{label}</span>
        <span className="hidden group-open:inline">{openLabel}</span>
      </summary>
      <div className={cn("mt-2 flex flex-col gap-3 rounded-lg p-3", bodyClassName)}>{children}</div>
    </details>
  );
}
