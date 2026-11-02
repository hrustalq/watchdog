"use server";

import { redirect } from "next/navigation";
import { claimInstance } from "@/lib/instance";
import { server } from "@/lib/server";
import { sendMagicLink } from "../sign-in/actions";

/**
 * Records the email as the one that may claim this install, then sends it a magic link. Its first
 * sign-in makes it the admin. A wrong or used token lands on the page's "doesn't work" state.
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
  await sendMagicLink(formData);
}
