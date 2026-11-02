"use server";

import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ProviderId } from "@/lib/auth";
import { server } from "@/lib/server";

/**
 * POSTs to a Better Auth endpoint through its HTTP handler, not `auth.api`, because its rate limit
 * only applies to requests that pass through the handler. The visitor's own headers carry their IP
 * for the rate limit and their Origin for the CSRF check.
 */
async function postToAuth(path: string, body: Record<string, unknown>) {
  const forwarded = new Headers(await headers());
  forwarded.delete("content-length");
  forwarded.set("content-type", "application/json");
  const { auth, baseURL } = server();
  return auth.handler(
    new Request(new URL(path, baseURL), { method: "POST", headers: forwarded, body: JSON.stringify(body) }),
  );
}

/** Asks Better Auth for a magic link. */
export async function sendMagicLink(formData: FormData) {
  const field = formData.get("email");
  const email = typeof field === "string" ? field.trim() : "";

  const response = await postToAuth("/api/auth/sign-in/magic-link", {
    email,
    callbackURL: "/",
    errorCallbackURL: "/sign-in",
  });

  if (response.ok) redirect(`/sign-in/check-email?email=${encodeURIComponent(email)}`);
  // Better Auth rejects an address it can't parse with a 400. A failed send is logged by it.
  if (response.status === 400) {
    redirect(`/sign-in?error=invalid-email&email=${encodeURIComponent(email)}`);
  }
  redirect(response.status === 429 ? "/sign-in?error=too-many" : "/sign-in?error=send-failed");
}

/**
 * Starts an OAuth sign-in and sends the browser to the provider. The provider arrives from the
 * client, so it's checked against the enabled ones rather than trusted.
 */
export async function signInWithProvider(provider: ProviderId) {
  if (!server().providers.includes(provider)) redirect("/sign-in");
  // `via` lets the sign-in page name the provider in an error notice.
  const signIn = `/sign-in?via=${provider}`;

  const response = await postToAuth("/api/auth/sign-in/social", {
    provider,
    callbackURL: "/",
    errorCallbackURL: signIn,
  });
  const body: unknown = response.ok ? await response.json() : null;
  if (typeof body !== "object" || body === null || !("url" in body) || typeof body.url !== "string") {
    redirect(`${signIn}&error=${response.status === 429 ? "too-many" : "start-failed"}`);
  }

  // The state cookie the callback checks. The handler returns it on the response, which a Server
  // Action doesn't pass on by itself.
  const jar = await cookies();
  for (const [name, cookie] of parseSetCookieHeader(response.headers.get("set-cookie") ?? "")) {
    jar.set(name, cookie.value, toCookieOptions(cookie));
  }
  redirect(body.url);
}
