import { Fragment } from "react";
import Link from "next/link";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";

export interface Crumb {
  /** The screen this step opens. The last crumb has none, because it is the screen itself. */
  href?: string;
  label: React.ReactNode;
}

const crumbLink =
  "inline-flex min-h-6 items-center rounded-sm text-muted-foreground underline-offset-4 outline-hidden hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/60";

/**
 * The 48px bar over a screen's content: the trail of screens above it, ending with this one. The last
 * crumb is always text and never a link, so a screen can't link to itself; it truncates instead of
 * widening the page, because a Rule's or an inbox's name can be anything. The structure under it is
 * the kit's Breadcrumb, so every trail has the same accessible shape.
 */
export function PageBar({ trail, className }: { trail: Crumb[]; className?: string }) {
  const current = trail.length - 1;
  return (
    <Breadcrumb aria-label="Breadcrumb" className={cn("flex h-12 items-center gap-2 border-b px-4 text-sm", className)}>
      <BreadcrumbList className="flex-nowrap gap-2">
        {trail.map((crumb, index) => (
          <Fragment key={`${String(index)}-${typeof crumb.label === "string" ? crumb.label : "crumb"}`}>
            <BreadcrumbItem className={index === current ? "min-w-0" : "shrink-0"}>
              {crumb.href === undefined ? (
                <BreadcrumbPage role={undefined} aria-disabled={undefined} className="min-w-0 truncate">{crumb.label}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink render={<Link href={crumb.href} />} className={crumbLink}>
                  {crumb.label}
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {index === current ? null : (
              <BreadcrumbSeparator className="shrink-0 text-muted-foreground">/</BreadcrumbSeparator>
            )}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
