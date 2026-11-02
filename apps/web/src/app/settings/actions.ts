"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { setSignupOpen } from "@/lib/instance";
import { requireWorkspace, server } from "@/lib/server";

/** Opens or closes sign-up. Only the instance admin may; anyone else is sent to their Workspace. */
// Bound arguments come back from the client, so `open` is only the request, checked to be true.
export async function setSignup(open: unknown) {
  const { admin } = await requireWorkspace();
  if (!admin) redirect("/");
  await setSignupOpen(server().db, open === true);
  refresh();
}
