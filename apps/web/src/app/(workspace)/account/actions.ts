"use server";

import { headers } from "next/headers";
import { redirect, RedirectType } from "next/navigation";
import { requireWorkspace, server } from "@/lib/server";
import { afterDeletion, deleteAccount, logoutTelegramSession } from "@/lib/workspace-deletion";

/**
 * Deletes the account: the user row, every Workspace it owns and everything under them, then signs
 * it out. The session names the account, so a post can only ever delete the caller's own. A typed
 * email that isn't the account's comes back to the page as refused, and nothing is deleted; without
 * a session there is nothing to delete, and `requireWorkspace` goes to sign-in instead.
 */
export async function deleteAccountAction(formData: FormData) {
  const { user } = await requireWorkspace();
  const { db, auth, mode, encryptionKey, boss } = server();
  const typedEmail = formData.get("email");
  const outcome = await deleteAccount(
    db,
    { user: { id: user.id, email: user.email }, typedEmail: typeof typedEmail === "string" ? typedEmail : "" },
    // The pre-delete step runs once per Workspace: each one's Telegram session is logged out on
    // Telegram before its row cascades away.
    { encryptionKey, boss, beforeDelete: logoutTelegramSession },
  );
  if (outcome === "wrong-email") redirect("/account?delete=email", RedirectType.replace);
  // The account's row is gone, so its sessions are too; this clears the cookie the browser holds.
  await auth.api.signOut({ headers: await headers() });
  redirect(await afterDeletion(db, mode));
}
