import { correction, type Db, desc, eq } from "@watchdog/db";

/** The examples of the user's judgement that an Agent call takes as context, newest first. */
export function recentCorrections(db: Db, workspaceId: string) {
  return db
    .select({
      kind: correction.kind,
      title: correction.itemTitle,
      summary: correction.itemSummary,
      before: correction.before,
      after: correction.after,
    })
    .from(correction)
    .where(eq(correction.workspaceId, workspaceId))
    .orderBy(desc(correction.createdAt))
    .limit(20);
}
