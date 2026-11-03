import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { server } from "@/lib/server";

// Not a "use server" module: its exports take redirect targets, which a client must not choose.

/**
 * POSTs to a Better Auth endpoint through its HTTP handler, not `auth.api`, because its rate limit
 * only applies to requests that pass through the handler. The visitor's own headers carry their IP
 * for the rate limit and their Origin for the CSRF check.
 */
export async function postToAuth(path: string, body: Record<string, unknown>) {
  const forwarded = new Headers(await headers());
  forwarded.delete("content-length");
  forwarded.set("content-type", "application/json");
  const { auth, baseURL } = server();
  return auth.handler(
    new Request(new URL(path, baseURL), { method: "POST", headers: forwarded, body: JSON.stringify(body) }),
  );
}

/**
 * Asks Better Auth for a magic link for the form's email, then goes to check-email. A failure goes
 * back to `errorPage` with an `error` code (and the email, when it was the problem). `from` tells
 * check-email which page sent the link.
 */
export async function requestMagicLink(
  formData: FormData,
  { errorPage, from }: { errorPage: string; from?: "setup" },
) {
  const field = formData.get("email");
  const email = typeof field === "string" ? field.trim() : "";

  // No callbackURL: the emailed link opens the confirm page, whose form sets where verify lands.
  const response = await postToAuth("/api/auth/sign-in/magic-link", { email });

  const sent = new URLSearchParams({ email });
  if (from !== undefined) sent.set("from", from);
  if (response.ok) redirect(`/sign-in/check-email?${sent}`);

  const back = new URL(errorPage, "http://watchdog.invalid");
  // Better Auth rejects an address it can't parse with a 400. A failed send is logged by it.
  if (response.status === 400) {
    back.searchParams.set("error", "invalid-email");
    back.searchParams.set("email", email);
  } else {
    back.searchParams.set("error", response.status === 429 ? "too-many" : "send-failed");
  }
  redirect(`${back.pathname}${back.search}`);
}
