import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";
import { pathHeader, returnTo, signInPath } from "./lib/return-to.ts";

/**
 * Sends a visitor with no session cookie to sign-in, which returns them to the page they asked for,
 * and answers an API call with no session cookie with a 401. This only checks that the cookie
 * exists; the page or route validates the session itself and rejects an expired or forged one too.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (getSessionCookie(request) !== null) {
    // So the page's own redirect to sign-in can keep the path too.
    const headers = new Headers(request.headers);
    headers.set(pathHeader, `${pathname}${search}`);
    return NextResponse.next({ request: { headers } });
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  return NextResponse.redirect(new URL(signInPath(returnTo(`${pathname}${search}`)), request.url));
}

// Every route needs a session except sign-in, setup, Better Auth's own endpoints, Next's build output
// and public/ files (any non-API path ending in an extension).
export const config = {
  matcher: ["/((?!sign-in(?:/|$)|setup$|api/auth/|_next/static/|_next/image|(?!api/).*\\.\\w+$).*)"],
};
