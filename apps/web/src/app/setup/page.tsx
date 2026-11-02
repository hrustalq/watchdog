import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { setupTokenValid } from "@/lib/instance";
import { server } from "@/lib/server";
import { SignInForm } from "../sign-in/sign-in-form";
import { claimAndSendLink } from "./actions";

export const metadata: Metadata = { title: "Set up · Watchdog" };

export default function SetupPage({ searchParams }: PageProps<"/setup">) {
  return (
    <Suspense fallback={null}>
      <Setup searchParams={searchParams} />
    </Suspense>
  );
}

// A failed send comes back here with the token, so the operator stays on setup to try again.
const notices: Record<string, string> = {
  "too-many": "Too many sign-in attempts. Wait a minute, then try again.",
  "send-failed":
    "Watchdog couldn't send the email. Check its mail (SMTP) settings and try again, or leave them all empty so the link is printed to the web container's log.",
};

async function Setup({ searchParams }: Pick<PageProps<"/setup">, "searchParams">) {
  const { token, error, email } = await searchParams;
  const { db, mode } = server();
  // Hosted installs have no first-run admin, so there's no setup page to find.
  if (mode !== "self-hosted") notFound();
  const valid = typeof token === "string" && (await setupTokenValid(db, token));

  if (!valid) {
    return (
      <>
        <div className="flex flex-col gap-1">
          <h1 className="text-headline">This setup link doesn&apos;t work</h1>
          <p className="text-sm text-muted-foreground">
            It&apos;s out of date or already used. Until Watchdog has an admin, it prints a new setup
            link each time it starts. If you run it, the latest one is in the web container&apos;s
            log.
          </p>
        </div>
        <Link
          href="/sign-in"
          className="inline-flex h-8 items-center self-start rounded-sm text-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          Go to sign-in
        </Link>
      </>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-headline">Set up Watchdog</h1>
        <p className="text-sm text-muted-foreground">
          The email you enter becomes this Watchdog&apos;s admin, who decides whether others can
          sign up. We&apos;ll send you a link that signs you in.
        </p>
      </div>
      <SignInForm
        action={claimAndSendLink}
        hidden={<input type="hidden" name="token" value={token} />}
        email={typeof email === "string" ? email : ""}
        invalidEmail={error === "invalid-email"}
        notice={typeof error === "string" ? notices[error] : undefined}
      />
    </>
  );
}
