import { type Db, eq, profile } from "@watchdog/db";

/**
 * The Profile an Agent call takes as context. A Workspace with no saved Profile works, with an empty
 * body and `en`. Nothing caches it, so a saved change applies from the next call.
 */
export async function loadProfile(db: Db, workspaceId: string) {
  const [row] = await db
    .select({ body: profile.body, outputLanguage: profile.outputLanguage })
    .from(profile)
    .where(eq(profile.workspaceId, workspaceId));
  return row ?? { body: "", outputLanguage: "en" };
}
