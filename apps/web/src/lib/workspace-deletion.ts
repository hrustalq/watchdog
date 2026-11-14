// Deleting a Workspace and its owner's account (docs: Security and privacy, "Deleting and exporting
// a Workspace"): every child table references `workspace` with `on delete cascade`, `workspace`
// cascades from `user`, and a self-hosted install's admin is the user row that just went.
import type { Config } from "@watchdog/core";
import { type Db, eq, type Tx, user } from "@watchdog/db";
import type { PgBoss } from "pg-boss";

/** The Workspace the account owns, as the Settings screen read it. */
export interface WorkspaceToDelete {
  id: string;
  name: string;
  ownerUserId: string;
}

/**
 * What the step before the rows go has to work with. Deleting the owner's user row takes the
 * Workspace and everything under it, so anything that has to happen while the rows still exist does
 * it here: read what only the rows hold, and queue the work that outlives them on a client the
 * worker owns.
 */
export interface BeforeDelete {
  /** The delete's own transaction. Its rows are readable here and gone when it commits. */
  tx: Tx;
  workspace: WorkspaceToDelete;
  /** WATCHDOG_ENCRYPTION_KEY, for the secrets a row holds, such as a Telegram session's. */
  encryptionKey: Buffer;
  /** Queue a job for the worker: the web app sends jobs but runs none. */
  boss: () => Promise<PgBoss>;
}

/** Runs inside the delete's transaction, before any row goes. */
export type BeforeWorkspaceDelete = (context: BeforeDelete) => Promise<void>;

/** What the delete did, which the screen turns into a redirect either way. */
export type DeleteOutcome = "deleted" | "wrong-name";

/**
 * Deletes the account, which takes the Workspace and every child table with it in one transaction.
 * The typed name has to be the Workspace's own: the check is here, not only in the form, so a post
 * that skips the form deletes nothing.
 *
 * `beforeDelete` is the one pre-delete step, and it runs before the delete inside the same
 * transaction. GitHub issue #314 fills it: the Workspace's Telegram session has to be logged out on
 * Telegram before its row cascades away, which needs the ciphertext read here, and the job that
 * does it needs the queue above. Until then nothing of the Workspace outlives it elsewhere.
 */
export async function deleteWorkspace(
  db: Db,
  { workspace, typedName }: { workspace: WorkspaceToDelete; typedName: string },
  {
    encryptionKey,
    boss,
    beforeDelete,
  }: { encryptionKey: Buffer; boss: () => Promise<PgBoss>; beforeDelete?: BeforeWorkspaceDelete },
): Promise<DeleteOutcome> {
  if (typedName !== workspace.name) return "wrong-name";
  await db.transaction(async (tx) => {
    await beforeDelete?.({ tx, workspace, encryptionKey, boss });
    // One statement: `workspace` follows `owner_user_id`, and every child a foreign key of its own,
    // so the Workspace's Sources, Items and their Log, Corrections, Rules, Destinations, Actions,
    // Deliveries, Profile, model config, Agent calls and Telegram rows go with it.
    await tx.delete(user).where(eq(user.id, workspace.ownerUserId));
  });
  return "deleted";
}

/**
 * Where the browser of a deleted account lands. Deleting a self-hosted install's admin leaves
 * `instance_settings.admin_user_id` null, which makes it an install nobody has claimed: its setup
 * page takes a claim again, and its next start prints a new setup link.
 */
export async function afterDeletion(db: Db, mode: Config["mode"]): Promise<string> {
  if (mode !== "self-hosted") return "/sign-in";
  const settings = await db.query.instanceSettings.findFirst();
  return settings?.adminUserId === null ? "/setup" : "/sign-in";
}
