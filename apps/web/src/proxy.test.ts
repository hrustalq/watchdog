import { getRedirectUrl, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { pathHeader } from "./lib/return-to.ts";
import { config, proxy } from "./proxy.ts";

describe("proxy", () => {
  it.each(["/", "/sources", "/api/sources", "/sign-out", "/settings", "/setup-other", "/api/sources/export.csv"])("guards the app route %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
  });

  it.each([
    "/sign-in",
    "/sign-in/check-email",
    "/sign-in/confirm?token=a-token",
    "/setup",
    "/api/auth/sign-in/magic-link",
    "/api/auth/magic-link/verify",
    "/api/auth/callback/github",
    "/_next/static/chunks/app.js",
    "/favicon.ico",
    "/robots.txt",
    "/logo.svg",
    "/images/logo.png",
  ])("lets %s through without a session", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
  });

  it("redirects a request without a session cookie to sign-in", () => {
    const response = proxy(new NextRequest("http://localhost:3000/"));
    expect(getRedirectUrl(response)).toBe("http://localhost:3000/sign-in");
  });

  it("keeps the requested page in next when it redirects to sign-in", () => {
    const response = proxy(new NextRequest("http://localhost:3000/some/page?x=1"));
    expect(getRedirectUrl(response)).toBe("http://localhost:3000/sign-in?next=%2Fsome%2Fpage%3Fx%3D1");
  });

  it("keeps nothing in next that would leave the site", () => {
    const response = proxy(new NextRequest("http://localhost:3000//evil.example"));
    expect(getRedirectUrl(response)).toBe("http://localhost:3000/sign-in");
  });

  it("tells the page its own path, so its redirect for an expired session can keep it", () => {
    const request = new NextRequest("http://localhost:3000/settings?tab=1", {
      // A path the browser sent itself is replaced, never trusted.
      headers: { cookie: "better-auth.session_token=a-token", [pathHeader]: "/elsewhere" },
    });
    expect(proxy(request).headers.get(`x-middleware-request-${pathHeader}`)).toBe("/settings?tab=1");
  });

  it("answers an API call without a session cookie with a JSON 401", async () => {
    const response = proxy(new NextRequest("http://localhost:3000/api/sources"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not signed in" });
  });

  it("passes a request with a session cookie on to the app", () => {
    const request = new NextRequest("http://localhost:3000/", {
      headers: { cookie: "better-auth.session_token=a-token" },
    });
    expect(getRedirectUrl(proxy(request))).toBeNull();
  });
});
