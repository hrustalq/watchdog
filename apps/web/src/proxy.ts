import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Sends a visitor with no session cookie to sign-in. This only checks that the cookie exists; the
 * page validates the session itself and redirects too when it's expired or forged.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request) !== null) return NextResponse.next();
  return NextResponse.redirect(new URL("/sign-in", request.url));
}

// Every route needs a session except sign-in, setup, Better Auth's own endpoints and static files.
export const config = {
  matcher: ["/((?!sign-in(?:/|$)|setup$|api/auth/|_next/static/|_next/image|favicon\\.ico$).*)"],
};
