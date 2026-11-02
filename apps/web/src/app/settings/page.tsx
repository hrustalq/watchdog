import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { requireWorkspace, server } from "@/lib/server";
import { SubmitButton } from "../sign-in/submit-button";
import { setSignup } from "./actions";

export const metadata: Metadata = { title: "Settings · Watchdog" };

export default function SettingsPage() {
  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link
          href="/"
          className="rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          Workspace
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span className="text-title">Settings</span>
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
        <h1 className="text-headline">Settings</h1>
        <Suspense fallback={null}>
          <SignupSection />
        </Suspense>
      </main>
    </div>
  );
}

/** Only the admin of a self-hosted install has settings so far. */
async function SignupSection() {
  const { admin } = await requireWorkspace();
  if (!admin) redirect("/");
  const open = (await server().db.query.instanceSettings.findFirst())?.signupOpen === true;
  return (
    <section
      aria-labelledby="sign-up"
      className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex flex-col gap-1">
        <h2 id="sign-up" className="text-title">
          Sign-up is {open ? "open" : "closed"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {open
            ? "Anyone who reaches this Watchdog can sign up with their email and get their own Workspace."
            : "Only people who already have an account can sign in. A new email is told that sign-up is closed."}
        </p>
      </div>
      <form action={setSignup.bind(null, !open)} className="shrink-0">
        <SubmitButton variant="outline" pendingLabel={open ? "Closing…" : "Opening…"}>
          {open ? "Close sign-up" : "Open sign-up"}
        </SubmitButton>
      </form>
    </section>
  );
}
