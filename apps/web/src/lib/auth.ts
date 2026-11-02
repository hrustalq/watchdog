import type { Config, Mailer } from "@watchdog/core";
import type { Db } from "@watchdog/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { signupRefusal } from "./instance.ts";

export const linkLifetimeMinutes = 15;

interface AuthDeps {
  /** Self-hosted installs gate sign-up on the first-run admin and the sign-up switch. */
  mode: Config["mode"];
  /** BETTER_AUTH_URL: magic links are built on it. */
  baseURL: string;
  secret: string;
  db: Db;
  mailer: Mailer;
  /** OAuth credentials from the config. A provider without them is left out. */
  oauth?: Partial<Config["oauth"]>;
}

/** The OAuth providers Watchdog supports, in the order the sign-in page offers them. */
const providerIds = ["google", "github"] as const;
export type ProviderId = (typeof providerIds)[number];
export const providerNames: Record<ProviderId, string> = { google: "Google", github: "GitHub" };

/** The providers whose ID and secret are both set. */
export function enabledProviders(oauth: Partial<Config["oauth"]>) {
  return providerIds.filter((id) => oauth[id] !== undefined);
}

/**
 * Better Auth with magic-link sign-in, plus Google and GitHub when their credentials are set. Either
 * way signs up an email it hasn't seen before.
 */
export function createAuth({ mode, baseURL, secret, db, mailer, oauth = {} }: AuthDeps) {
  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg" }),
    socialProviders: {
      ...(oauth.google && { google: oauth.google }),
      ...(oauth.github && { github: oauth.github }),
    },
    // Better Auth's default account linking attaches an OAuth sign-in to the existing user with
    // the same email only when the provider says that email is verified; no provider is trusted
    // beyond its own flag. Creating a user is held to the same bar, so an unverified provider email
    // never makes a user row that would sit on someone else's address.
    // A self-hosted install also creates no user before its admin claims it, and after that only
    // while the admin has sign-up open. Existing users aren't created again, so they still sign in.
    // The refusal comes when the link is opened, not when it's asked for, so asking doesn't reveal
    // which emails have an account.
    user: {
      validateUserInfo: async ({ user, source }) => {
        if (source.action !== "create-user") return undefined;
        if (source.method === "oauth" && user.emailVerified !== true) return { error: "email_not_verified" };
        const refusal = mode === "self-hosted" ? await signupRefusal(db, user.email ?? "") : undefined;
        return refusal === undefined ? undefined : { error: refusal };
      },
    },
    // An OAuth failure Better Auth can't send to the sign-in's own error URL lands on sign-in too.
    onAPIError: { errorURL: "/sign-in" },
    // Self-hosted Watchdog sends nothing home (ADR 0013), and hosted doesn't either.
    telemetry: { enabled: false },
    plugins: [
      magicLink({
        expiresIn: linkLifetimeMinutes * 60,
        // Only a hash of the token is stored, so a database read can't be turned into a sign-in.
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await mailer.send({
            to: email,
            subject: "Sign in to Watchdog",
            text: [
              "Open this link to sign in to Watchdog:",
              "",
              url,
              "",
              `It works once and expires in ${String(linkLifetimeMinutes)} minutes.`,
              "If you didn't ask to sign in, you can ignore this email.",
            ].join("\n"),
          });
        },
      }),
      // Applies Set-Cookie from auth calls made in Server Actions. It has to be the last plugin.
      nextCookies(),
    ],
  });
}
