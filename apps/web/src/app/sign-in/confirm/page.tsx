import type { Metadata } from "next";
import { Suspense } from "react";
import { verifyForm } from "@/lib/auth";
import { ConfirmForm } from "./confirm-form";

export const metadata: Metadata = { title: "Sign in · Watchdog" };

/**
 * Where the emailed magic link lands. Loading it spends nothing, so a mail gateway that fetches the
 * link first leaves it working. The button GETs Better Auth's verify endpoint, which spends the
 * token, sets the session cookie and redirects: to the Workspace, or to sign-in's "expired" notice.
 */
export default function ConfirmPage({ searchParams }: PageProps<"/sign-in/confirm">) {
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-headline">Finish signing in</h1>
        <p className="text-sm text-muted-foreground">
          Press the button to sign in. We ask first so that a mail scanner opening the link
          can&apos;t use it up before you do.
        </p>
      </div>
      {/* The button is in the static shell; the token, read from the URL, streams in over it. */}
      <Suspense fallback={<ConfirmForm />}>
        <ConfirmFormWithToken searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function ConfirmFormWithToken({ searchParams }: Pick<PageProps<"/sign-in/confirm">, "searchParams">) {
  const { token } = await searchParams;
  // A missing token is sent anyway: Better Auth answers with the "expired" notice on sign-in.
  return (
    <ConfirmForm
      action={verifyForm.action}
      fields={{ token: typeof token === "string" ? token : "", ...verifyForm.fields }}
    />
  );
}
