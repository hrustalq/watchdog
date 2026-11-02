"use server";

import { redirect } from "next/navigation";
import { claimInstance } from "@/lib/instance";
import { server } from "@/lib/server";
import { requestMagicLink } from "../sign-in/request-link";

/**
 * Records the email as the one that may claim this install, then sends it a magic link. Its first
 * sign-in makes it the admin. A wrong or used token lands on the page's "doesn't work" state, and
 * a failed send comes back here with the token, so the operator can try again.
 */
export async function claimAndSendLink(formData: FormData) {
  const token = formData.get("token");
  const email = formData.get("email");
  const { db, mode } = server();
  const claimed =
    mode === "self-hosted" &&
    typeof token === "string" &&
    typeof email === "string" &&
    (await claimInstance(db, token, email));
  if (!claimed) redirect("/setup");
  await requestMagicLink(formData, { errorPage: `/setup?${new URLSearchParams({ token })}`, from: "setup" });
}
