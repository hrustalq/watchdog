import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

/** Also what another Workspace's Item looks like, so a page can't tell whether one exists. */
export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <h1 className="text-headline">Nothing here</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        This page doesn&apos;t exist. An Item is removed with its Source, so a link to one can stop
        working.
      </p>
      <Link href="/" className={`${buttonVariants({ variant: "outline" })} mt-6`}>
        Back to the Feed
      </Link>
    </main>
  );
}
