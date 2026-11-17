import { cn } from "@/lib/utils";

/**
 * The page for a screen with one thing to say, centred over the height it has: sign-in, a 404, a
 * page that failed to load, a confirmation link. It is not a Page: there is no reading column and
 * nothing to scan, so this owns the whole height and the 16-step padding instead. It is a `main` by
 * default; pass `as="div"` when it renders inside the Workspace shell, whose inset already owns the
 * screen's one main landmark.
 */
export function CenteredPage({
  as = "main",
  className,
  children,
}: {
  as?: "main" | "div";
  className?: string;
  children: React.ReactNode;
}) {
  const Tag = as;
  return <Tag className={cn("flex flex-1 flex-col items-center justify-center px-4 py-16", className)}>{children}</Tag>;
}

/** The 24rem column inside a CenteredPage: the brand line and a form, or one short outcome. */
export function CenteredColumn({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex w-full max-w-sm flex-col gap-6", className)}>{children}</div>;
}
