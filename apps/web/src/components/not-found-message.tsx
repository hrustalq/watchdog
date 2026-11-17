import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/**
 * The words every 404 shares: one headline, the sentence that says the page is gone, and the way
 * back to the Feed. The page around it decides whether those words sit in `CenteredPage`'s own
 * `main` or in the Workspace shell's, so a miss never nests a second main.
 */
export function NotFoundMessage({ item }: { item: boolean }) {
  return (
    <>
      <h1 className="text-headline">Nothing here</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        This page doesn&apos;t exist.
        {item ? " An Item is removed with its Source, so a link to one can stop working." : ""}
      </p>
      <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-6" })}>
        Back to the Feed
      </Link>
    </>
  );
}
