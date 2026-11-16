import { requireWorkspace } from "@/lib/server";
import { WorkspaceChrome } from "./workspace-chrome";

// The shared header reads the session, so authenticated routes intentionally block on the server.
export const instant = false;

export default async function WorkspaceLayout({ children }: LayoutProps<"/">) {
  const { user, workspace } = await requireWorkspace();
  return (
    <WorkspaceChrome workspaceName={workspace.name} email={user.email}>
      {children}
    </WorkspaceChrome>
  );
}
