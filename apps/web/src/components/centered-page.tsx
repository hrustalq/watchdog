import { cn } from "@/lib/utils";

/**
 * The page for a screen with one thing to say, centred over the height it has: sign-in, a 404, a
 * page that failed to load, a confirmation link. It is not a Page: there is no reading column and
 * nothing to scan, so this owns the whole height and the 16-step padding instead.
 */
export function CenteredPage({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <main className={cn("flex flex-1 flex-col items-center justify-center px-4 py-16", className)}>{children}</main>
  );
}

/** The 24rem column inside a CenteredPage: the brand line and a form, or one short outcome. */
export function CenteredColumn({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex w-full max-w-sm flex-col gap-6", className)}>{children}</div>;
}
