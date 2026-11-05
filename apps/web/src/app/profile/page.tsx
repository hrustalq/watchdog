import { loadProfile } from "@watchdog/core";
import type { Metadata } from "next";
import Link from "next/link";
import { maxProfileBody, outputLanguages } from "@/lib/profile";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "../sign-in/notice";
import { ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Profile · Watchdog" };

// The data is read without Suspense, so the form and what's wrong with it are in the first HTML, which
// is how they work without JavaScript. In a static shell, an empty form could replace the saved Profile.
export const instant = false;

export default async function ProfilePage({ searchParams }: PageProps<"/profile">) {
  const [{ workspace }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const saved = await loadProfile(server().db, workspace.id);

  // These come from the URL, so only a refusal brings text back, and only a listed language counts.
  const refused = params.error === "too-long";
  const sentBackBody = refused && typeof params.body === "string" ? params.body : undefined;
  const sentBackLanguage = refused ? outputLanguages.find(({ code }) => code === params.language) : undefined;
  const bodyLost = refused && sentBackBody === undefined;

  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link
          href="/"
          className="rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          Workspace
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span aria-current="page">Profile</span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <h1 className="text-headline">Profile</h1>
        {params.saved === "1" ? (
          <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
            Profile saved.
          </Notice>
        ) : null}
        <ProfileForm
          body={sentBackBody ?? saved.body}
          language={sentBackLanguage?.code ?? saved.outputLanguage}
          languages={outputLanguages}
          maxBody={maxProfileBody}
          refused={refused}
          bodyLost={bodyLost}
        />
      </main>
    </div>
  );
}
