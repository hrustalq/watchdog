import { cn } from "@/lib/utils";

/**
 * The empty screen inside a page: one Headline, the line that says why it is empty, and at most one
 * action under it. It centres in whatever height the page has left, so an empty Feed reads as a
 * state and not as a missing list that failed to load. `children` carries the Body line and the
 * action; the component keeps the measure (`max-w-md`) and the 24px step to the action out of each
 * screen.
 */
export function EmptyState({ title, className, children }: { title: React.ReactNode; className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center py-16 text-center", className)}>
      <h2 className="text-headline">{title}</h2>
      {children}
    </div>
  );
}
