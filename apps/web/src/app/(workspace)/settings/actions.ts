"use server";

import { refresh } from "next/cache";
import { headers } from "next/headers";
import { redirect, RedirectType } from "next/navigation";
import { setSignupOpen } from "@/lib/instance";
import { requireWorkspace, server } from "@/lib/server";
import {
  deliveryRefusalQuery,
  readDeliverySettingsForm,
  readRetentionSettingsForm,
  retentionRefusalQuery,
  saveDeliverySettings,
  saveHealthAlertDestinations,
  saveRetentionSettings,
} from "@/lib/settings";
import { afterDeletion, deleteWorkspace, logoutTelegramSession } from "@/lib/workspace-deletion";

/**
 * Saves the Delivery tab of the user's Workspace, which comes from the session and never from the
 * form. Every outcome is a redirect, because without JavaScript a returned value would leave a blank
 * page, and it names the tab, so the notice or the refusal lands where the save came from. A refused
 * form comes back in the URL as it was posted: none of it is private, it carries that tab's values
 * and no other's, and the page reads what's wrong from it with the same check, so a crafted link
 * can't put words on the page.
 */
export async function saveDeliverySettingsAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const { db, mode } = server();
  const posted = readDeliverySettingsForm((name) => formData.get(name));
  const result = await saveDeliverySettings(db, workspace.id, posted, { selfHosted: mode === "self-hosted" });
  // Replaced, because Back to the page before the save could save its old values over the new ones. A
  // refusal is replaced too, or a save after it would leave that page one Back away.
  if ("saved" in result) redirect("/settings?tab=delivery&saved=delivery", RedirectType.replace);
  redirect(`/settings?${deliveryRefusalQuery(posted)}`, RedirectType.replace);
}

/**
 * Saves the Retention tab, the same way and on its own: a refusal or a save keeps the other tab's
 * columns as they were and redirects back to this one.
 */
export async function saveRetentionSettingsAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const { db, mode } = server();
  const posted = readRetentionSettingsForm((name) => formData.get(name));
  const result = await saveRetentionSettings(db, workspace.id, posted, { selfHosted: mode === "self-hosted" });
  if ("saved" in result) redirect("/settings?tab=retention&saved=retention", RedirectType.replace);
  redirect(`/settings?${retentionRefusalQuery(posted)}`, RedirectType.replace);
}

/**
 * Saves which Destinations Source Health alerts go to. Nothing in the form can be wrong in a way the user
 * could fix: a ticked box is a Destination the page offered, and anything else is left out.
 */
export async function saveHealthAlertsAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const ids = formData.getAll("destination").filter((value) => typeof value === "string");
  await saveHealthAlertDestinations(server().db, workspace.id, ids);
  redirect("/settings?tab=health&saved=health", RedirectType.replace);
}

/** Opens or closes sign-up. Only the instance admin may; anyone else is sent to their Workspace. */
// Bound arguments come back from the client, so `open` is only the request, checked to be true.
export async function setSignup(open: unknown) {
  const { admin } = await requireWorkspace();
  if (!admin) redirect("/");
  await setSignupOpen(server().db, open === true);
  refresh();
}

/**
 * Deletes the Workspace and the account that owns it, then signs that account out and sends it away.
 * The session names the Workspace and the account, so a post can only ever delete the caller's own.
 * A typed name that isn't the Workspace's comes back to the Workspace tab as refused, and nothing is
 * deleted; without a session there is nothing to delete, and `requireWorkspace` goes to sign-in instead.
 */
export async function deleteWorkspaceAction(formData: FormData) {
  const { user, workspace } = await requireWorkspace();
  const { db, auth, mode, encryptionKey, boss } = server();
  const typedName = formData.get("name");
  const outcome = await deleteWorkspace(
    db,
    {
      workspace: { id: workspace.id, name: workspace.name, ownerUserId: user.id },
      typedName: typeof typedName === "string" ? typedName : "",
    },
    // The pre-delete step: the Workspace's Telegram session is logged out on Telegram before its row
    // cascades away, and the key and the queue that needs are handed over here.
    { encryptionKey, boss, beforeDelete: logoutTelegramSession },
  );
  if (outcome === "wrong-name") redirect("/settings?tab=workspace&delete=name", RedirectType.replace);
  // The account's row is gone, so its sessions are too; this clears the cookie the browser holds.
  await auth.api.signOut({ headers: await headers() });
  redirect(await afterDeletion(db, mode));
}
