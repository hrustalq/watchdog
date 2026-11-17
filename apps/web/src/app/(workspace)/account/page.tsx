import type { Metadata } from "next";
import { dataBox } from "@/components/field-classes";
import { TextField } from "@/components/form-field";
import { Notice } from "@/components/notice";
import { Page, PageHeader } from "@/components/page";
import { PageBar } from "@/components/page-bar";
import { Section } from "@/components/section";
import { SubmitButton } from "@/components/submit-button";
import { requireWorkspace } from "@/lib/server";
import { cn } from "@/lib/utils";
import { signOut } from "../actions";
import { deleteAccountAction } from "./actions";

export const metadata: Metadata = { title: "Account · Watchdog" };

// The email and the refusal are read without Suspense, so the form works without JavaScript.
export const instant = false;

export default async function AccountPage({ searchParams }: PageProps<"/account">) {
  const [{ user }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const refused = params.delete === "email";

  return (
    <div className="flex flex-1 flex-col">
      <PageBar trail={[{ href: "/", label: "Workspace" }, { label: "Account" }]} />
      <Page gap={6}>
        <PageHeader
          title="Account"
          description="Your account owns every Workspace you have. Its Workspaces are on the Workspaces screen, where each can be renamed or deleted."
        />

        <Section id="signed-in-heading" title="Signed in as" tone="panel" gap={4}>
          <p className="text-sm break-all">{user.email}</p>
        </Section>

        <Section id="sign-out-heading" title="Sign out" tone="panel" gap={4}>
          <p className="max-w-[70ch] text-sm text-muted-foreground">
            This ends the session on this browser. Your Workspaces and their data stay as they are.
          </p>
          <form action={signOut}>
            <SubmitButton variant="outline" pendingLabel="Signing out…" className="sm:w-auto sm:self-start">
              Sign out
            </SubmitButton>
          </form>
        </Section>

        <Section
          id="delete-account-heading"
          title="Delete account"
          tone="panel"
          gap={4}
          description={
            <>
              This deletes the account and every Workspace it owns, with everything in them: Sources, Items and their
              Log, Corrections, Rules, Destinations, Actions, Deliveries, Profile, model settings, Agent calls and
              Telegram connections. It signs you out, and it can&apos;t be undone.
            </>
          }
        >
          {refused ? (
            <Notice role="alert">
              That isn&apos;t this account&apos;s email, so nothing was deleted. Type{" "}
              <strong className="break-all">{user.email}</strong> to confirm.
            </Notice>
          ) : null}
          <form action={deleteAccountAction} className="flex flex-col gap-4">
            <TextField
              id="delete-email"
              name="email"
              label={<>Type {user.email} to confirm</>}
              type="text"
              required
              autoComplete="off"
              help="The address you sign in with, exactly as it is above."
              controlClassName={cn(dataBox, "sm:max-w-sm")}
            />
            <SubmitButton variant="destructive" pendingLabel="Deleting…" className="sm:w-auto sm:self-start">
              Delete account
            </SubmitButton>
          </form>
        </Section>
      </Page>
    </div>
  );
}
