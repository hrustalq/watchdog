import { and, correction, type Db, desc, eq, isNotNull, or } from "@watchdog/db";

/**
 * The examples of the user's judgement that an Agent call takes as context, newest first. A
 * Correction with neither a title nor a summary says nothing about what was corrected, and takes a
 * place a useful example could have, so it waits until #162 fills its summary in.
 */
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
    .where(
      and(
        eq(correction.workspaceId, workspaceId),
        or(isNotNull(correction.itemTitle), isNotNull(correction.itemSummary)),
      ),
    )
    .orderBy(desc(correction.createdAt))
    .limit(20);
}
