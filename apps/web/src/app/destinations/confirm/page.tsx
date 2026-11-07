import type { Metadata } from "next";
import Link from "next/link";
import { confirmationAddress } from "@/lib/destinations";
import { server } from "@/lib/server";
import { Notice } from "../../sign-in/notice";
import { SubmitButton } from "../../sign-in/submit-button";
import { confirmDestinationAction } from "../actions";

// The URL holds a live token: keep it out of search indexes and out of Referer headers to other sites.
// Not "no-referrer" as on the magic link's page: under it a browser sends a POST with `Origin: null`,
// which Next refuses as a cross-site Server Action. That page's form is a GET, and this one's can't be.
export const metadata: Metadata = {
  title: "Address confirmation · Watchdog",
  robots: { index: false, follow: false },
  referrer: "same-origin",
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
  const address =
    result === undefined && typeof token === "string" ? await confirmationAddress(server().db, token) : undefined;
  return (
    <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <p className="text-title">Watchdog</p>
        <Step token={token} address={address} confirmed={result === "confirmed"} />
      </div>
    </main>
  );
}

function Step({
  token,
  address,
  confirmed,
}: {
  token: unknown;
  address: string | undefined;
  confirmed: boolean;
}) {
  if (confirmed) {
    return (
      <Outcome title="Address confirmed" role="status">
        Alerts can now be sent to this address. You can close this page. If you added it,{" "}
        <Link href="/destinations" className="underline underline-offset-4">
          go to your Destinations
        </Link>
        .
      </Outcome>
    );
  }
  if (address === undefined || typeof token !== "string") {
    return (
      <Outcome title="That link has expired or was already used" role="alert">
        Whoever added this address can send a new link from the Destinations screen.
      </Outcome>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="text-headline">Confirm this address</h1>
        <p className="text-sm text-muted-foreground">
          Someone asked Watchdog to send its alerts to{" "}
          <span className="font-mono text-[0.8125rem] break-all text-foreground">{address}</span>. Press the button
          to agree. If you didn&apos;t expect this, close the page, and nothing will be sent here.
        </p>
      </div>
      <form action={confirmDestinationAction}>
        <input type="hidden" name="token" value={token} />
        <SubmitButton pendingLabel="Confirming…">Confirm this address</SubmitButton>
      </form>
    </>
  );
}

/** A result the page arrives with. Nothing else tells a screen reader, because the title doesn't change. */
function Outcome({
  title,
  role,
  children,
}: {
  title: string;
  role: "status" | "alert";
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-headline">{title}</h1>
      <Notice role={role} className="text-sm text-muted-foreground">
        {children}
      </Notice>
    </div>
  );
}
