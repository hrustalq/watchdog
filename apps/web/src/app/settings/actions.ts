"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { setSignupOpen } from "@/lib/instance";
import { requireWorkspace, server } from "@/lib/server";

/** Opens or closes sign-up. Only the instance admin may; anyone else is sent to their Workspace. */
// `open` is bound on the server, and Next.js encrypts bound arguments, so the client can't change it.
export async function setSignup(open: boolean) {
  const { admin } = await requireWorkspace();
  if (!admin) redirect("/");
  await setSignupOpen(server().db, open);
  refresh();
}
