import { cn } from "@/lib/utils";

const list = "divide-y rounded-lg border";

/**
 * A list of rows that share one hairline border, each row divided from the next. It replaces the
 * per-page `divide-y rounded-lg border` markup; `as` picks the element the rows deserve: `ul` for
 * rows without an order, `ol` for a Log, and `div` for a form whose sections are not list items.
 */
export function PanelList({
  as = "ul",
  className,
  children,
}: {
  as?: "ul" | "ol" | "div";
  className?: string;
  children: React.ReactNode;
}) {
  if (as === "ol") return <ol className={cn(list, className)}>{children}</ol>;
  if (as === "div") return <div className={cn(list, className)}>{children}</div>;
  return <ul className={cn(list, className)}>{children}</ul>;
}

/**
 * One row of a PanelList: the row's title block on the left and its controls on the right, stacked
 * on a phone so a 32px control never squeezes the name. It stays an `li`, because the same shape
 * everywhere is the point: a row that is not a list item is a different component.
 */
export function PanelRow({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <li className={cn("flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between", className)}>
      {children}
    </li>
  );
}
