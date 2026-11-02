"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { server } from "@/lib/server";

/**
 * Asks Better Auth for a magic link. The request goes through Better Auth's HTTP handler, not
 * `auth.api`, because its rate limit only applies to requests that pass through the handler.
 */
export async function sendMagicLink(formData: FormData) {
  const field = formData.get("email");
  const email = typeof field === "string" ? field.trim() : "";

  // The visitor's own headers carry their IP for the rate limit and their Origin for the CSRF check.
  const forwarded = new Headers(await headers());
  forwarded.delete("content-length");
  forwarded.set("content-type", "application/json");
  const { auth, baseURL } = server();
  const response = await auth.handler(
    new Request(new URL("/api/auth/sign-in/magic-link", baseURL), {
      method: "POST",
      headers: forwarded,
      body: JSON.stringify({ email, callbackURL: "/", errorCallbackURL: "/sign-in" }),
    }),
  );

  if (response.ok) redirect(`/sign-in/check-email?email=${encodeURIComponent(email)}`);
  // Better Auth rejects an address it can't parse with a 400. A failed send is logged by it.
  if (response.status === 400) {
    redirect(`/sign-in?error=invalid-email&email=${encodeURIComponent(email)}`);
  }
  redirect(response.status === 429 ? "/sign-in?error=too-many" : "/sign-in?error=send-failed");
}
