import { cn } from "@/lib/utils";

const widths = { wide: "max-w-none", narrow: "max-w-2xl" } as const;
const gaps = { 4: "gap-4", 6: "gap-6", 8: "gap-8", none: undefined } as const;

/**
 * The content column a screen sits in. `wide` fills the shell's inset, so lists and Feed rows use
 * the room the sidebar leaves instead of a centred 48rem strip with large side margins; `narrow`
 * keeps a 42rem column where a form would otherwise stretch its lines. The 4px rhythm arrives as
 * the column's gap, so screens don't each pick their own spacing. It is a `div`, not a `main`: the
 * Workspace shell's inset owns the screen's one main landmark, and a second one inside it would
 * split the page in two for a screen reader. Sign-in, the 404 and the error page are not Pages:
 * they centre one short column over the whole height instead.
 */
export function Page({
  width = "wide",
  gap = 8,
  className,
  children,
}: {
  width?: keyof typeof widths;
  gap?: keyof typeof gaps;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto flex w-full flex-col px-4 py-6 sm:px-6", widths[width], gaps[gap], className)}>
      {children}
    </div>
  );
}

/**
 * A screen's one h1 and the line under it that says what the screen is. `actions` sits on the h1's
 * row and wraps under it on a phone; put the Feed's view switch there, not a second heading.
 */
export function PageHeader({
  title,
  description,
  actions,
  titleClassName,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** For a title that can be a long name, such as a Rule's: `break-words`. */
  titleClassName?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className={actions === undefined ? undefined : "flex flex-wrap items-center justify-between gap-x-4 gap-y-2"}>
        <h1 className={cn("text-headline", titleClassName)}>{title}</h1>
        {actions}
      </div>
      {description === undefined ? null : <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
