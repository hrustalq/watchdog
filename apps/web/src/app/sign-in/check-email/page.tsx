import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { linkLifetimeMinutes } from "@/lib/auth";
import { returnTo, signInPath } from "@/lib/return-to";
import { server } from "@/lib/server";

export const metadata: Metadata = { title: "Check your email · Watchdog" };

export default function CheckEmailPage({ searchParams }: PageProps<"/sign-in/check-email">) {
  return (
    <>
      <Suspense fallback={null}>
        <Sent searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={null}>
        <DifferentEmail searchParams={searchParams} />
      </Suspense>
    </>
  );
}

/**
 * Sign-in can't correct the email given on the setup page, because only the setup link can claim
 * the install. So after setup this points back to that link instead.
 */
async function DifferentEmail({ searchParams }: Pick<PageProps<"/sign-in/check-email">, "searchParams">) {
  const { from, next } = await searchParams;
  if (from === "setup") {
    return (
      <p className="text-sm text-muted-foreground">
        Typed the wrong email? Open the setup link from the log again and enter the right one. It
        keeps working until the admin signs in.
      </p>
    );
  }
  return (
    <Link
      href={signInPath(returnTo(next))}
      className="inline-flex h-8 items-center self-start rounded-sm text-sm font-medium underline-offset-4 outline-hidden hover:underline focus-visible:ring-3 focus-visible:ring-ring/60"
    >
      Use a different email
    </Link>
  );
}

/** Read per request: the mail settings come from the runtime environment, not the build. */
async function Sent({ searchParams }: Pick<PageProps<"/sign-in/check-email">, "searchParams">) {
  await connection();
  const { email } = await searchParams;
  // Only something shaped like an address is shown, so the URL can't put other text on the page.
  const recipient =
    typeof email === "string" && /^[^\s@]+@[^\s@]+$/.test(email) ? (
      <span className="font-medium text-foreground">{email}</span>
    ) : (
      "your email"
    );
  const expiry = `It works once and expires in ${String(linkLifetimeMinutes)} minutes.`;

  if (server().mailGoesToLog) {
    return (
      <div className="flex flex-col gap-1">
        <h1 className="text-headline">Open the link from the server log</h1>
        <p className="text-sm text-muted-foreground">
          No mail server (SMTP) is set up, so the sign-in link for {recipient} was printed to the
          web container&apos;s log, under &ldquo;Open this link to sign in to Watchdog&rdquo;.{" "}
          {expiry}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-headline">Check your email</h1>
      <p className="text-sm text-muted-foreground">
        We sent a sign-in link to {recipient}. {expiry}
      </p>
    </div>
  );
}
