"use server";

import { redirect } from "next/navigation";
import { saveProfile, tooLongFormQuery } from "@/lib/profile";
import { requireWorkspace, server } from "@/lib/server";

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Saves the Profile of the user's Workspace, which comes from the session and never from the form.
 * Every outcome is a redirect, because without JavaScript a returned value would leave a blank page.
 * The form only posts languages from its list, so an unknown one just goes back to the page.
 */
export async function saveProfileAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const input = { body: text(formData, "body"), language: text(formData, "language") };
  const result = await saveProfile(server().db, workspace.id, input);
  if ("saved" in result) redirect("/profile?saved=1");
  redirect(result.problem === "too-long" ? `/profile?${tooLongFormQuery(input).toString()}` : "/profile");
}
