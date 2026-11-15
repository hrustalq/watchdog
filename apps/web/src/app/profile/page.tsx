import { loadProfile } from "@watchdog/core";
import type { Metadata } from "next";
import { PageBar } from "@/components/page-bar";
import { Page, PageHeader } from "@/components/page";
import { maxProfileBody, outputLanguages } from "@/lib/profile";
import { requireWorkspace, server } from "@/lib/server";
import { ProfileForm } from "./profile-form";

export const metadata: Metadata = { title: "Profile · Watchdog" };

// The data is read without Suspense, so the form and what's wrong with it are in the first HTML, which
// is how they work without JavaScript. In a static shell, an empty form could replace the saved Profile.
export const instant = false;

export default async function ProfilePage({ searchParams }: PageProps<"/profile">) {
  const [{ workspace }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const saved = await loadProfile(server().db, workspace.id);

  return (
    <div className="flex flex-1 flex-col">
      <PageBar trail={[{ href: "/", label: "Workspace" }, { label: "Profile" }]} />
      <Page gap={6}>
        <PageHeader title="Profile" />
        <ProfileForm
          body={saved.body}
          language={saved.outputLanguage}
          languages={outputLanguages}
          maxBody={maxProfileBody}
          refused={params.error === "too-long"}
          justSaved={params.saved === "1"}
        />
      </Page>
    </div>
  );
}
