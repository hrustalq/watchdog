import { createHash, randomBytes } from "node:crypto";
import type { Config } from "@watchdog/core";
import { and, eq, instanceSettings, isNull, type Db } from "@watchdog/db";

// The first-run admin and the sign-up switch of a self-hosted install. Hosted mode uses none of it.

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");
const settingsOf = (db: Db) => db.query.instanceSettings.findFirst();

/**
 * Called once at boot. While a self-hosted install has no admin, it makes a new setup token,
 * replacing any earlier one, and returns the setup URL that carries it. Only a hash is stored, so
 * the URL exists only in the web container's log.
 */
export async function setupUrl(mode: Config["mode"], db: Db, baseURL: string) {
  if (mode !== "self-hosted") return undefined;
  const token = randomBytes(32).toString("base64url");
  await db.insert(instanceSettings).values({}).onConflictDoNothing();
  const issued = await db
    .update(instanceSettings)
    .set({ setupTokenHash: hashOf(token) })
    .where(isNull(instanceSettings.adminUserId))
    .returning({ id: instanceSettings.id });
  return issued.length === 0 ? undefined : `${new URL(`/setup?token=${token}`, baseURL)}`;
}

/** Whether the token is the one in the setup URL and the install still has no admin. */
export async function setupTokenValid(db: Db, token: string) {
  const settings = await settingsOf(db);
  return settings?.adminUserId === null && settings.setupTokenHash === hashOf(token);
}

/**
 * The setup page: with the setup URL's token, records the email that may sign up while there's no
 * admin. Its first sign-in makes it the admin. A later claim replaces an earlier one, so a mistyped
 * email can be corrected with the same URL until the admin exists.
 */
export async function claimInstance(db: Db, token: string, email: string) {
  const claimed = await db
    .update(instanceSettings)
    .set({ claimedEmail: email.trim().toLowerCase() })
    .where(and(isNull(instanceSettings.adminUserId), eq(instanceSettings.setupTokenHash, hashOf(token))))
    .returning({ id: instanceSettings.id });
  return claimed.length > 0;
}

/**
 * Why a self-hosted install won't create a user for this email, or undefined when it will. With no
 * settings row (boot couldn't write one) it refuses, so a failed boot can't leave sign-up open.
 */
export async function signupRefusal(db: Db, email: string) {
  const settings = await settingsOf(db);
  if (settings === undefined || settings.adminUserId === null) {
    return email !== "" && settings?.claimedEmail === email.toLowerCase() ? undefined : "setup_pending";
  }
  return settings.signupOpen ? undefined : "signup_closed";
}

/**
 * Whether the user is the instance admin. The user who claimed the install becomes it here, on
 * their first request, which also retires the setup token.
 */
export async function isInstanceAdmin(db: Db, user: { id: string; email: string }) {
  const settings = await settingsOf(db);
  if (settings?.adminUserId === null && settings.claimedEmail === user.email.toLowerCase()) {
    await db
      .update(instanceSettings)
      .set({ adminUserId: user.id, claimedEmail: null, setupTokenHash: null })
      .where(and(isNull(instanceSettings.adminUserId), eq(instanceSettings.claimedEmail, settings.claimedEmail)));
    return (await settingsOf(db))?.adminUserId === user.id;
  }
  return settings?.adminUserId === user.id;
}

/** Opens or closes sign-up for emails Watchdog hasn't seen. Check that the caller is the admin. */
export async function setSignupOpen(db: Db, open: boolean) {
  await db.update(instanceSettings).set({ signupOpen: open });
}
