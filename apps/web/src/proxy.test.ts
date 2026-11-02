import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { config, proxy } from "./proxy.ts";

describe("proxy", () => {
  it.each(["/", "/sources", "/api/sources", "/sign-out"])("guards the app route %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });

  it.each([
    "/sign-in",
    "/sign-in/check-email",
    "/api/auth/sign-in/magic-link",
    "/api/auth/magic-link/verify",
    "/api/auth/callback/github",
    "/_next/static/chunks/app.js",
    "/favicon.ico",
  ])("lets %s through without a session", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });

  it("redirects a request without a session cookie to sign-in", () => {
    const response = proxy(new NextRequest("http://localhost:3000/"));
    expect(getRedirectUrl(response)).toBe("http://localhost:3000/sign-in");
  });

  it("passes a request with a session cookie on to the app", () => {
    const request = new NextRequest("http://localhost:3000/", {
      headers: { cookie: "better-auth.session_token=a-token" },
    });
    expect(getRedirectUrl(proxy(request))).toBeNull();
  });
});
