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

export const metadata: Metadata = { title: "Not found · Watchdog" };

/**
 * The 404 for a miss inside the Workspace shell, such as `/sources/telegram` without a bot. The
 * shell's inset already renders the page's `main`, so this one is a plain div: two mains would make
 * "jump to main" ambiguous. The route root's not-found still owns URLs that match no route at all.
 */
export default async function WorkspaceNotFound() {
  const item = (await headers()).get(itemMissHeader) !== null;
  return (
    <CenteredPage as="div" className="text-center">
      <NotFoundMessage item={item} />
    </CenteredPage>
  );
}
