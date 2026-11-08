"use server";

import { refresh } from "next/cache";
import { redirect, RedirectType } from "next/navigation";
import { setSignupOpen } from "@/lib/instance";
import { requireWorkspace, server } from "@/lib/server";
import { alertSettingsQuery, readAlertSettingsForm, saveAlertSettings } from "@/lib/settings";

/**
 * Saves the alert settings of the user's Workspace, which comes from the session and never from the form.
 * Every outcome is a redirect, because without JavaScript a returned value would leave a blank page. A
 * refused form comes back in the URL as it was posted: none of it is private, and the page reads what's
 * wrong from it with the same check, so a crafted link can't put words on the page.
 */
export async function saveSettingsAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const form = readAlertSettingsForm((name) => formData.get(name));
  const result = await saveAlertSettings(server().db, workspace.id, form);
  // Replaced, because Back to the page before the save could save its old values over the new ones.
  if ("saved" in result) redirect("/settings?saved=1", RedirectType.replace);
  redirect(`/settings?${alertSettingsQuery(form)}`);
}

/** Opens or closes sign-up. Only the instance admin may; anyone else is sent to their Workspace. */
// Bound arguments come back from the client, so `open` is only the request, checked to be true.
export async function setSignup(open: unknown) {
  const { admin } = await requireWorkspace();
  if (!admin) redirect("/");
  await setSignupOpen(server().db, open === true);
  refresh();
}
