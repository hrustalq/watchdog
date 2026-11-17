"use server";

import { revalidatePath } from "next/cache";
import { redirect, RedirectType } from "next/navigation";
import { activateWorkspace, activeWorkspaceId } from "@/lib/active-workspace";
import { requireWorkspace, server } from "@/lib/server";
import { isUuid } from "@/lib/uuid";
import { createWorkspace, listWorkspaces, renameWorkspace, workspaceName } from "@/lib/workspace";
import { deleteWorkspace, logoutTelegramSession } from "@/lib/workspace-deletion";

/** Where every refusal and every saved outcome lands, so the screen that posted them shows what happened. */
const page = "/workspaces";

/**
 * Back to the Workspaces screen with an outcome in the URL. Every action ends here, because without
 * JavaScript a returned value would leave a blank page, and replaced rather than pushed, so Back
 * doesn't post again.
 */
function back(query: Record<string, string>): never {
  redirect(`${page}?${new URLSearchParams(query).toString()}`, RedirectType.replace);
}

/**
 * One Workspace by id, only when the signed-in user owns it. Ids come back from the client, so every
 * action checks the owner again here rather than trusting the page that posted it.
 */
async function ownedWorkspace(ownerId: string, value: unknown) {
  if (typeof value !== "string" || !isUuid(value)) return undefined;
  return server().db.query.workspace.findFirst({
    where: (table, { and, eq }) => and(eq(table.id, value), eq(table.ownerUserId, ownerId)),
  });
}

/**
 * Makes one of the signed-in user's Workspaces the one this browser reads. The cookie is a
 * preference: `workspaceFor` checks the id against the owner on every later request, so a wrong one
 * only ever falls back. The layout is revalidated because the sidebar, the Workspace's name and every
 * screen under it change with the choice.
 */
export async function switchWorkspaceAction(formData: FormData) {
  const { user } = await requireWorkspace();
  const workspace = await ownedWorkspace(user.id, formData.get("workspace"));
  if (workspace === undefined) back({ refused: "unknown" });
  await activateWorkspace(workspace.id, server().baseURL);
  revalidatePath("/", "layout");
  redirect("/");
}

/**
 * Creates a Workspace named by the form and switches to it, so the empty Workspace it starts as is
 * what the user sees next. It arrives with the database's defaults and no Sources, rules,
 * Destinations, Profile or model copied from anywhere.
 */
export async function createWorkspaceAction(formData: FormData) {
  const { user } = await requireWorkspace();
  const name = workspaceName(formData.get("name"));
  if (name === undefined) back({ refused: "blank" });
  const created = await createWorkspace(server().db, user.id, name);
  if (created === undefined) back({ refused: "duplicate" });
  await activateWorkspace(created.id, server().baseURL);
  revalidatePath("/", "layout");
  back({ saved: "created" });
}

/**
 * Renames one of the user's Workspaces. The layout is revalidated because the sidebar and the
 * Settings screen show the name. A refused rename comes back with the row it belongs to, so its form
 * opens on the name as it was typed.
 */
export async function renameWorkspaceAction(workspaceId: unknown, formData: FormData) {
  const { user } = await requireWorkspace();
  const workspace = await ownedWorkspace(user.id, workspaceId);
  if (workspace === undefined) back({ refused: "unknown" });
  const posted = formData.get("name");
  const typed = typeof posted === "string" ? posted : "";
  const refused = (code: string) => ({ refused: code, id: workspace.id, name: typed });
  const name = workspaceName(posted);
  if (name === undefined) back(refused("blank"));
  const outcome = await renameWorkspace(server().db, user.id, workspace.id, name);
  if (outcome === "missing") back({ refused: "unknown" });
  if (outcome === "duplicate") back(refused("duplicate"));
  revalidatePath("/", "layout");
  back({ saved: "renamed" });
}

/**
 * Deletes one Workspace and everything in it, and leaves the account signed in. The typed name has to
 * be the Workspace's own, and the last Workspace is refused: deleting the account is its own action.
 * When the one that went was the active one, the cookie moves to the oldest that's left, which is
 * where `workspaceFor` would fall back to anyway.
 */
export async function deleteWorkspaceAction(workspaceId: unknown, formData: FormData) {
  const { user } = await requireWorkspace();
  const { db, encryptionKey, boss } = server();
  const workspace = await ownedWorkspace(user.id, workspaceId);
  if (workspace === undefined) back({ refused: "unknown" });
  const typedName = formData.get("name");
  const outcome = await deleteWorkspace(
    db,
    {
      workspace: { id: workspace.id, name: workspace.name, ownerUserId: user.id },
      typedName: typeof typedName === "string" ? typedName : "",
    },
    { encryptionKey, boss, beforeDelete: logoutTelegramSession },
  );
  if (outcome === "wrong-name") back({ refused: "name", id: workspace.id });
  if (outcome === "last-one") back({ refused: "last", id: workspace.id });
  if ((await activeWorkspaceId()) === workspace.id) {
    const [next] = await listWorkspaces(db, user.id);
    if (next !== undefined) await activateWorkspace(next.id, server().baseURL);
  }
  revalidatePath("/", "layout");
  back({ saved: "deleted" });
}
