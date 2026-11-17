// Deleting one Workspace, or the account that owns them all (docs: Security and privacy, "Deleting
// and exporting a Workspace"). Every child table references `workspace` with `on delete cascade`,
// `workspace` cascades from `user`, and a self-hosted install's admin is the user row that just went.
import { type Config, queueSessionLogout } from "@watchdog/core";
import { and, type Db, eq, type Tx, user, workspace } from "@watchdog/db";
import type { PgBoss } from "pg-boss";

/** A Workspace as the screen that deletes it read it. */
export interface WorkspaceToDelete {
  id: string;
  name: string;
  ownerUserId: string;
}

/**
 * What the step before the rows go has to work with. The delete takes the Workspace and everything
 * under it, so anything that has to happen while the rows still exist does it here: read what only
 * the rows hold, and queue the work that outlives them on a client the worker owns.
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

/**
 * The pre-delete step: the Workspace's Telegram session has to be logged out on Telegram before its
 * row cascades away (docs: Security and privacy, "Deleting and exporting a Workspace"). The job it
 * queues carries the encrypted secret, because only the worker decrypts a session and the row is
 * gone by the time it runs. Telegram never holds the delete: a job that can't reach it retries on
 * its own, and the Workspace's data goes now.
 */
export const logoutTelegramSession: BeforeWorkspaceDelete = async ({ tx, workspace: target, boss }) => {
  await queueSessionLogout(tx, target.id, await boss());
};

/** What deleting one Workspace did, which the screen turns into a redirect or a refusal. */
export type DeleteOutcome = "deleted" | "wrong-name" | "last-one";

/**
 * Deletes one Workspace and every child table with it, in one transaction. The typed name has to be
 * the Workspace's own: the check is here, not only in the form, so a post that skips the form deletes
 * nothing.
 *
 * It refuses the owner's last Workspace. An account with none has nowhere to go, and account deletion
 * is the action that removes the account itself. The owner's `user` row is locked first, so two
 * deletes of two siblings queue behind each other instead of each seeing two Workspaces and taking
 * both.
 *
 * `beforeDelete` is the one pre-delete step, and it runs before the delete inside the same
 * transaction: `logoutTelegramSession` reads what only the rows hold and queues the work that
 * outlives them, because the delete cascades the Telegram session row away.
 */
export async function deleteWorkspace(
  db: Db,
  { workspace: target, typedName }: { workspace: WorkspaceToDelete; typedName: string },
  {
    encryptionKey,
    boss,
    beforeDelete,
  }: { encryptionKey: Buffer; boss: () => Promise<PgBoss>; beforeDelete?: BeforeWorkspaceDelete },
): Promise<DeleteOutcome> {
  if (typedName !== target.name) return "wrong-name";
  return db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, target.ownerUserId)).for("update");
    const owned = await tx
      .select({ id: workspace.id })
      .from(workspace)
      .where(eq(workspace.ownerUserId, target.ownerUserId));
    if (owned.length <= 1) return "last-one";
    await beforeDelete?.({ tx, workspace: target, encryptionKey, boss });
    // One statement: every child a foreign key of the Workspace, so its Sources, Items and their Log,
    // Corrections, Rules, Destinations, Actions, Deliveries, Profile, model config, Agent calls and
    // Telegram rows go with it.
    await tx
      .delete(workspace)
      .where(and(eq(workspace.id, target.id), eq(workspace.ownerUserId, target.ownerUserId)));
    return "deleted";
  });
}

/** What deleting the account did. */
export type AccountDeleteOutcome = "deleted" | "wrong-email";

/**
 * Deletes the account: the user row, every Workspace it owns and everything under them, in one
 * transaction. The typed email has to be the account's own, so a post that skips the form deletes
 * nothing.
 *
 * `beforeDelete` runs once per Workspace, inside that transaction and before any row goes, because
 * each Workspace's Telegram session has to be logged out while its row is still readable.
 */
export async function deleteAccount(
  db: Db,
  { user: account, typedEmail }: { user: { id: string; email: string }; typedEmail: string },
  {
    encryptionKey,
    boss,
    beforeDelete,
  }: { encryptionKey: Buffer; boss: () => Promise<PgBoss>; beforeDelete?: BeforeWorkspaceDelete },
): Promise<AccountDeleteOutcome> {
  if (typedEmail.trim() !== account.email) return "wrong-email";
  await db.transaction(async (tx) => {
    // The lock the sibling delete takes too, so an account delete and a Workspace delete can't cross.
    await tx.select({ id: user.id }).from(user).where(eq(user.id, account.id)).for("update");
    const owned = await tx
      .select({ id: workspace.id, name: workspace.name, ownerUserId: workspace.ownerUserId })
      .from(workspace)
      .where(eq(workspace.ownerUserId, account.id));
    for (const one of owned) await beforeDelete?.({ tx, workspace: one, encryptionKey, boss });
    await tx.delete(user).where(eq(user.id, account.id));
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
