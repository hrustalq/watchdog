import type { Metadata } from "next";
import { connection } from "next/server";
import Link from "next/link";
import { Suspense } from "react";
import { linkLifetimeMinutes } from "@/lib/auth";
import { server } from "@/lib/server";

export const metadata: Metadata = { title: "Check your email · Watchdog" };

export default function CheckEmailPage({ searchParams }: PageProps<"/sign-in/check-email">) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl leading-tight font-[650] tracking-[-0.02em]">Check your email</h1>
        <p className="text-sm text-muted-foreground">
          We sent a sign-in link to{" "}
          <Suspense fallback="your email">
            <Recipient searchParams={searchParams} />
          </Suspense>
          . It works once and expires in {linkLifetimeMinutes} minutes.
        </p>
      </div>
      <Suspense fallback={null}>
        <MailLogNotice />
      </Suspense>
      <Link href="/sign-in" className="text-sm font-medium underline-offset-4 hover:underline">
        Use a different email
      </Link>
    </>
  );
}

async function Recipient({ searchParams }: Pick<PageProps<"/sign-in/check-email">, "searchParams">) {
  const { email } = await searchParams;
  if (typeof email !== "string" || email === "") return "your email";
  return <span className="font-medium text-foreground">{email}</span>;
}

/** Read per request: the mail settings come from the runtime environment, not the build. */
async function MailLogNotice() {
  await connection();
  if (!server().mailGoesToLog) return null;
  return (
    <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
      This Watchdog has no mail server set up, so the link was printed to the web container&apos;s
      log instead of being emailed.
    </p>
  );
}
