import type { Mailer } from "@watchdog/core";
import type { Db } from "@watchdog/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";

export const linkLifetimeMinutes = 15;

interface AuthDeps {
  /** BETTER_AUTH_URL: magic links are built on it. */
  baseURL: string;
  secret: string;
  db: Db;
  mailer: Mailer;
}

/** Better Auth with magic-link sign-in. A link signs up an email it hasn't seen before. */
export function createAuth({ baseURL, secret, db, mailer }: AuthDeps) {
  return betterAuth({
    baseURL,
    secret,
    database: drizzleAdapter(db, { provider: "pg" }),
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
