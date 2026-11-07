import type { Metadata } from "next";
import Link from "next/link";
import { SubmitButton } from "../../sign-in/submit-button";
import { confirmDestinationAction } from "../actions";

// The URL holds a live token: keep it out of search indexes and out of any Referer header.
export const metadata: Metadata = {
  title: "Confirm this address · Watchdog",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

// As on the magic link's confirm page: only ever opened from an email, so an instant shell buys
// nothing, and waiting for the token puts the form in the first HTML, where it works without JavaScript.
export const instant = false;

/**
 * Where the emailed confirmation link lands. Loading it spends nothing, so a mail gateway that fetches
 * the link first leaves it working. The button spends the token.
 */
export default async function ConfirmDestinationPage({ searchParams }: PageProps<"/destinations/confirm">) {
  const { token, result } = await searchParams;
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <p className="text-title">Watchdog</p>
        <Step token={token} result={result} />
      </div>
    </main>
  );
}

function Step({ token, result }: { token: unknown; result: unknown }) {
  if (result === "confirmed") {
    return (
      <Outcome title="Address confirmed">
        Alerts can now be sent to this address. You can close this page, or{" "}
        <Link href="/destinations" className="underline underline-offset-4">
          go to your Destinations
        </Link>
        .
      </Outcome>
    );
  }
  if (result === "invalid" || typeof token !== "string") {
    return (
      <Outcome title="That link has expired or was already used">
        Whoever added this address can send a new link from the Destinations screen.
      </Outcome>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-headline">Confirm this address</h1>
        <p className="text-sm text-muted-foreground">
          Press the button to receive Watchdog alerts at this address. We ask first so that a mail scanner
          opening the link can&apos;t use it up. If you didn&apos;t expect this, close the page, and nothing
          will be sent here.
        </p>
      </div>
      <form action={confirmDestinationAction}>
        <input type="hidden" name="token" value={token} />
        <SubmitButton pendingLabel="Confirming…">Confirm this address</SubmitButton>
      </form>
    </>
  );
}

function Outcome({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-headline">{title}</h1>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
