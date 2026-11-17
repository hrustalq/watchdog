import { cookies } from "next/headers";
import { requireWorkspace, server } from "@/lib/server";
import { listWorkspaces } from "@/lib/workspace";
import { WorkspaceChrome } from "./workspace-chrome";

// The shared header reads the session, so authenticated routes intentionally block on the server.
export const instant = false;

export default async function WorkspaceLayout({ children }: LayoutProps<"/">) {
  const { user, workspace } = await requireWorkspace();
  // The switcher lists every Workspace the account owns, oldest first, and marks the one this
  // request reads. One indexed query beside the layout's own.
  const workspaces = await listWorkspaces(server().db, user.id);
  // The sidebar writes this cookie when it is collapsed; reading it here keeps the first paint in
  // the state the user left, without a script that would flash the open sidebar first.
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  return (
    <WorkspaceChrome
      workspaceName={workspace.name}
      workspaces={workspaces.map((one) => ({ id: one.id, name: one.name, active: one.id === workspace.id }))}
      email={user.email}
      defaultOpen={defaultOpen}
    >
      {children}
    </WorkspaceChrome>
  );
}
