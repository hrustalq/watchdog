import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { isDetailPath, missing, notFoundPath } from "./lib/missing.ts";
import { pathHeader, returnTo, signInPath } from "./lib/return-to.ts";
import { server } from "./lib/server.ts";

/**
 * Sends a visitor with no session cookie to sign-in, which returns them to the page they asked for,
 * and answers an API call with no session cookie with a 401. This only checks that the cookie
 * exists; the page or route validates the session itself and rejects an expired or forged one too.
 *
 * It also answers a missing Item or rule, which the page can't: Next.js starts streaming a page's
 * response, and fixes its status, before the page's own lookup finishes, so a `notFound()` there
 * renders the not-found UI with status 200 (bundled Next.js docs, loading.js, "Status codes").
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (getSessionCookie(request) === null) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    }
    return NextResponse.redirect(new URL(signInPath(returnTo(`${pathname}${search}`)), request.url));
  }
  // A visitor with no session is sent to sign-in instead, which says nothing about whether the page
  // exists. A missing Item or rule answers the not-found page with a 404 at the address it was given.
  if (isDetailPath(pathname)) {
    const { auth, db } = server();
    const session = await auth.api.getSession({ headers: request.headers });
    if (session !== null && (await missing(db, session.user.id, pathname))) {
      return NextResponse.rewrite(new URL(notFoundPath, request.url));
    }
  }
  // So the page's own redirect to sign-in can keep the path too.
  const headers = new Headers(request.headers);
  headers.set(pathHeader, `${pathname}${search}`);
  return NextResponse.next({ request: { headers } });
}

// Every route needs a session except sign-in, setup, a Destination's confirmation link (whose owner may
// have no account), a Digest mail's unsubscribe link (which a mail client POSTs to), Better Auth's own endpoints,
// the webhook inbox (whose token is its proof), Next's build output and public/ files (any non-API path
// ending in an extension).
export const config = {
  matcher: ["/((?!sign-in(?:/|$)|setup$|destinations/confirm$|unsubscribe$|api/auth/|api/inbox/|_next/static/|_next/image|(?!api/).*\\.\\w+$).*)"],
};
