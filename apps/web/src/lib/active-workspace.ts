import { cookies } from "next/headers";

/** The cookie that names the Workspace a request reads. It is a preference, never an authorization. */
export const activeWorkspaceCookie = "active_workspace";

/** A year, so a choice outlives the browser session the way a saved setting would. */
const year = 60 * 60 * 24 * 365;

/** The Workspace the last request read, as the cookie names it, or undefined when it names none. */
export async function activeWorkspaceId(): Promise<string | undefined> {
  return (await cookies()).get(activeWorkspaceCookie)?.value;
}

/**
 * Points this browser's next requests at a Workspace. Only a Server Action may write the cookie,
 * and it writes a preference: `workspaceFor` re-checks who owns the id on every request.
 */
export async function activateWorkspace(workspaceId: string, baseURL: string) {
  (await cookies()).set(activeWorkspaceCookie, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: baseURL.startsWith("https://"),
    path: "/",
    maxAge: year,
  });
}
