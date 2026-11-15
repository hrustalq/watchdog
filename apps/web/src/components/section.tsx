import { cn } from "@/lib/utils";

const tones = {
  plain: "gap-3",
  panel: "gap-3 rounded-lg border p-4",
  raised: "gap-3 rounded-lg border bg-card p-4",
  inset: "gap-4 p-4",
} as const;

const gaps = { 2: "gap-2", 3: "gap-3", 4: "gap-4" } as const;

/**
 * A titled block of a screen. Its heading id is the section's accessible name, so every Section names
 * itself to a screen reader and a page never ships an aria-labelledby pointing at nothing. `tone` is
 * the surface: `plain` for a heading over a list, `panel` for a bordered block on the graph floor,
 * `raised` for the same block in card tone, and `inset` for the sections stacked inside one
 * PanelList, which draws its own border. `description` is Body type capped at the 70ch measure; it
 * groups with the heading at 4px, so it reads as the heading's line and not as the first paragraph
 * of the content. `focusableTitle` makes the heading a programmatic focus target, for a screen that
 * removes a row and has nowhere else sensible to put the keyboard.
 */
export function Section({
  id,
  title,
  description,
  descriptionId,
  descriptionClassName,
  tone = "plain",
  gap,
  titleClassName,
  focusableTitle = false,
  className,
  children,
}: {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** An id a control points at with aria-describedby, when the description is its help. */
  descriptionId?: string;
  /** For the rare description that is a reading rather than help, such as the saved quiet hours. */
  descriptionClassName?: string;
  tone?: keyof typeof tones;
  gap?: keyof typeof gaps;
  titleClassName?: string;
  focusableTitle?: boolean;
  className?: string;
  children?: React.ReactNode;
}) {
  const heading = (
    <h2
      id={id}
      tabIndex={focusableTitle ? -1 : undefined}
      className={cn("text-title", focusableTitle && "outline-hidden", titleClassName)}
    >
      {title}
    </h2>
  );
  return (
    <section aria-labelledby={id} className={cn("flex flex-col", tones[tone], gap === undefined ? undefined : gaps[gap], className)}>
      {description === undefined ? (
        heading
      ) : (
        <div className="flex min-w-0 flex-col gap-1">
          {heading}
          <p id={descriptionId} className={cn("max-w-[70ch] text-sm text-muted-foreground", descriptionClassName)}>{description}</p>
        </div>
      )}
      {children}
    </section>
  );
}
