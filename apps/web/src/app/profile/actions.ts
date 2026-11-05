"use server";

import { redirect, RedirectType } from "next/navigation";
import { saveProfile } from "@/lib/profile";
import { requireWorkspace, server } from "@/lib/server";

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Saves the Profile of the user's Workspace, which comes from the session and never from the form.
 * Every outcome is a redirect, because without JavaScript a returned value would leave a blank page.
 * The refused text stays out of the URL: it's private, and a URL reaches logs and browser history.
 * The form only posts languages from its list, so an unknown one just goes back to the page.
 */
export async function saveProfileAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const input = { body: text(formData, "body"), language: text(formData, "language") };
  const result = await saveProfile(server().db, workspace.id, input);
  // Replaced, because Back to the page before the save could save its old values over the new ones.
  if ("saved" in result) redirect("/profile?saved=1", RedirectType.replace);
  redirect(result.problem === "too-long" ? "/profile?error=too-long" : "/profile");
}
