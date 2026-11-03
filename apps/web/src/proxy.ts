import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Sends a visitor with no session cookie to sign-in, and answers an API call with no session cookie
 * with a 401. This only checks that the cookie exists; the page or route validates the session itself
 * and rejects an expired or forged one too.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request) !== null) return NextResponse.next();
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/sign-in", request.url));
}

// Every route needs a session except sign-in, setup, Better Auth's own endpoints, Next's build output
// and files (any path ending in an extension, such as public/ files).
export const config = {
  matcher: ["/((?!sign-in(?:/|$)|setup$|api/auth/|_next/static/|_next/image|.*\\.\\w+$).*)"],
};
