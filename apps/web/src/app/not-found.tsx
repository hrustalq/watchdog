import type { Metadata } from "next";
import { headers } from "next/headers";
import { CenteredPage } from "@/components/centered-page";
import { NotFoundMessage } from "@/components/not-found-message";
import { itemMissHeader } from "@/lib/missing";

/**
 * A 404 renders per request, as the sentence it gives depends on what Proxy found missing; that
 * blocks, so it opts out of the instant-navigation validation (bundled Next.js docs, `instant`).
 */
export const instant = false;

// The tab says the page isn't there, rather than naming a page it isn't.
export const metadata: Metadata = { title: "Not found · Watchdog" };

/**
 * The 404 outside the Workspace shell: a URL that matches no route at all. It owns the only `main`
 * on the page, so it uses `CenteredPage`'s default. A miss inside the shell renders the group's
 * own not-found instead, which must not nest a second main.
 */
export default async function NotFound() {
  const item = (await headers()).get(itemMissHeader) !== null;
  return (
    <CenteredPage className="text-center">
      <NotFoundMessage item={item} />
    </CenteredPage>
  );
}
