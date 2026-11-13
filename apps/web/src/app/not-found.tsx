import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { itemMissHeader } from "@/lib/missing";

/**
 * A 404 renders per request, as the sentence it gives depends on what Proxy found missing; that
 * blocks, so it opts out of the instant-navigation validation (bundled Next.js docs, `instant`).
 */
export const instant = false;

// The tab says the page isn't there, rather than naming a page it isn't.
export const metadata: Metadata = { title: "Not found · Watchdog" };

/**
 * The one page every 404 renders, so a missing Item and another Workspace's Item look the same and
 * neither says whether one exists. Only an Item's miss says why it's gone, which Proxy passes on the
 * rewrite it answers the miss with.
 */
export default async function NotFound() {
  const item = (await headers()).get(itemMissHeader) !== null;
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16 text-center">
      <h1 className="text-headline">Nothing here</h1>
      <p className="mt-2 max-w-md text-sm text-muted-foreground">
        This page doesn&apos;t exist.
        {item ? " An Item is removed with its Source, so a link to one can stop working." : ""}
      </p>
      <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-6" })}>
        Back to the Feed
      </Link>
    </main>
  );
}
