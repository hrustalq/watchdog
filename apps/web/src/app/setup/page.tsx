import type { Metadata } from "next";
import Link from "next/link";
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

async function Setup({ searchParams }: Pick<PageProps<"/setup">, "searchParams">) {
  const { token } = await searchParams;
  const { db, mode } = server();
  const valid = mode === "self-hosted" && typeof token === "string" && (await setupTokenValid(db, token));

  if (!valid) {
    return (
      <>
        <div className="flex flex-col gap-1">
          <h1 className="text-headline">This setup link doesn&apos;t work</h1>
          <p className="text-sm text-muted-foreground">
            This Watchdog already has an admin, or it has restarted since this link was printed and
            printed a new one. Whoever runs it will find the current link in the web
            container&apos;s log.
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
          sign up. We&apos;ll send it a link that signs you in.
        </p>
      </div>
      <SignInForm
        action={claimAndSendLink}
        hidden={<input type="hidden" name="token" value={token} />}
      />
    </>
  );
}
