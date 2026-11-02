"use server";

import { parseSetCookieHeader, toCookieOptions } from "better-auth/cookies";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ProviderId } from "@/lib/auth";
import { server } from "@/lib/server";
import { postToAuth, requestMagicLink } from "./request-link";

/** Asks Better Auth for a magic link; a failure comes back to sign-in with its code. */
export async function sendMagicLink(formData: FormData) {
  await requestMagicLink(formData, { errorPage: "/sign-in" });
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
