import type { Metadata } from "next";
import { verifyForm } from "@/lib/auth";
import { ConfirmForm } from "./confirm-form";

// The URL holds a live token: keep it out of search indexes and out of any Referer header.
export const metadata: Metadata = {
  title: "Finish signing in · Watchdog",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// The page waits for the token instead of streaming it in after a static shell, so the form is
// in the first HTML and works without JavaScript. It's only ever opened from an email, never
// navigated to inside the app, so an instant shell would buy nothing.
export const instant = false;

/**
 * Where the emailed magic link lands. Loading it spends nothing, so a mail gateway that fetches the
 * link first leaves it working. The button GETs Better Auth's verify endpoint, which spends the
 * token, sets the session cookie and redirects: to the page sign-in was opened from, or to
 * sign-in's "expired" notice.
 */
export default async function ConfirmPage({ searchParams }: PageProps<"/sign-in/confirm">) {
  const { token, next } = await searchParams;
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-headline">Finish signing in</h1>
        <p className="text-sm text-muted-foreground">
          Press the button to sign in. We ask first so that a mail scanner opening the link
          can&apos;t use it up before you do.
        </p>
      </div>
      {/* A missing token is sent anyway: Better Auth answers with the "expired" notice on sign-in. */}
      <ConfirmForm
        action={verifyForm.action}
        fields={{ token: typeof token === "string" ? token : "", ...verifyForm.fields(next) }}
      />
    </>
  );
}
