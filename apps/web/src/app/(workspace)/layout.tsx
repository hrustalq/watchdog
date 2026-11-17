import { cookies } from "next/headers";
import { requireWorkspace } from "@/lib/server";
import { WorkspaceChrome } from "./workspace-chrome";

// The shared header reads the session, so authenticated routes intentionally block on the server.
export const instant = false;

export default async function WorkspaceLayout({ children }: LayoutProps<"/">) {
  const { user, workspace } = await requireWorkspace();
  // The sidebar writes this cookie when it is collapsed; reading it here keeps the first paint in
  // the state the user left, without a script that would flash the open sidebar first.
  const defaultOpen = (await cookies()).get("sidebar_state")?.value !== "false";
  return (
    <WorkspaceChrome workspaceName={workspace.name} email={user.email} defaultOpen={defaultOpen}>
      {children}
    </WorkspaceChrome>
  );
}
