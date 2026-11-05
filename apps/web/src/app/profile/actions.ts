"use server";

import { redirect } from "next/navigation";
import { profileFormQuery, saveProfile } from "@/lib/profile";
import { requireWorkspace, server } from "@/lib/server";

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Saves the Profile of the user's Workspace, which comes from the session and never from the form.
 * Every outcome is a redirect, because without JavaScript a returned value would leave a blank page.
 */
export async function saveProfileAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const input = { body: text(formData, "body"), language: text(formData, "language") };
  const result = await saveProfile(server().db, workspace.id, input);
  if ("problem" in result) redirect(`/profile?${profileFormQuery(result.problem, input).toString()}`);
  redirect("/profile?saved=1");
}
