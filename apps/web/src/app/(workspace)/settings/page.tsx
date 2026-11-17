import type { Metadata } from "next";
import Link from "next/link";
import { label, textLink } from "@/components/field-classes";
import { CheckboxField } from "@/components/form-field";
import { Notice } from "@/components/notice";
import { PageBar } from "@/components/page-bar";
import { Page, PageHeader } from "@/components/page";
import { Section } from "@/components/section";
import { SubmitButton } from "@/components/submit-button";
import { requireWorkspace, server } from "@/lib/server";
import {
  loadAlertSettings,
  loadHealthAlertDestinations,
  parseAlertSettings,
  readDeliverySettingsForm,
  readRetentionSettingsForm,
  resolveSettingsTab,
  type SettingsTab,
  settingsFormValues,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { saveHealthAlertsAction, setSignup } from "./actions";
import { DeliveryPanel, RetentionPanel } from "./panels";
import { SettingsTabs } from "./settings-tabs";

export const metadata: Metadata = { title: "Settings · Watchdog" };

// The data is read without Suspense, so the forms and what's wrong with them are in the first HTML, which
// is how they work without JavaScript. In a static shell, an empty form could replace the saved settings.
export const instant = false;

const help = "text-xs text-muted-foreground";

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const [{ user, workspace, admin }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const { db, mode } = server();
  const selfHosted = mode === "self-hosted";
  // The URL is the state: a missing or unknown tab is Delivery, so a stale link opens the page.
  const tab = resolveSettingsTab(params.tab, { admin });
  const saved = await loadAlertSettings(db, workspace.id);
  const values = settingsFormValues(saved, { selfHosted });

  // A refused save comes back with its own tab's form as it was posted, and what's wrong is read from it
  // again. A link whose values pass the check isn't a refusal, so the form shows what's saved, not its values.
  const posted = params.refused === "1" ? postedSettingsForm(tab, (name) => params[name]) : undefined;
  const parsed = posted === undefined ? undefined : parseAlertSettings({ ...values, ...posted }, { selfHosted });
  const errors = parsed !== undefined && "errors" in parsed ? parsed.errors : {};
  const refused = Object.keys(errors).length > 0 ? posted : undefined;
  // What each panel shows: the saved row, or the refused tab's fields over it.
  const shown = { ...values, ...refused };

  return (
    <div className="flex flex-1 flex-col">
      <PageBar trail={[{ href: "/", label: "Workspace" }, { label: "Settings" }]} />
      <Page gap={6}>
        <PageHeader title="Settings" />

        <SettingsTabs current={tab} workspaceName={workspace.name} admin={admin} />

        {tab === "delivery" ? (
          <DeliveryPanel
            saved={saved}
            values={shown}
            errors={errors}
            notice={params.saved === "delivery" ? "Settings saved. The next alert follows them." : undefined}
            hosted={mode === "hosted"}
          />
        ) : null}

        {tab === "retention" ? (
          <RetentionPanel
            values={shown}
            errors={errors}
            notice={params.saved === "retention" ? "Retention saved. The next sweep follows it." : undefined}
            selfHosted={selfHosted}
          />
        ) : null}

        {tab === "health" ? (
          <>
            {params.saved === "health" ? (
              <Notice role="status">Source Health alerts saved. The next one follows them.</Notice>
            ) : null}
            <HealthAlertsSection workspaceId={workspace.id} email={user.email} />
          </>
        ) : null}

        {tab === "workspace" ? <WorkspaceSection name={workspace.name} /> : null}

        {/* Only an admin's URL resolves to Instance, so there is no second check to make here. */}
        {tab === "instance" ? <SignupSection /> : null}
      </Page>
    </div>
  );
}

/**
 * The tab's own form as it was posted, or undefined for a tab whose panel isn't a settings form. Each
 * tab reads only its own field names, so a link can't carry another tab's values into the check.
 */
function postedSettingsForm(tab: SettingsTab, get: (name: string) => unknown) {
  if (tab === "delivery") return readDeliverySettingsForm(get);
  if (tab === "retention") return readRetentionSettingsForm(get);
  return undefined;
}

/**
 * The Workspace this page belongs to. Renaming, creating another and deleting one are the Workspaces
 * screen's, which the sidebar's switcher opens too, so this tab says the name and points there.
 */
function WorkspaceSection({ name }: { name: string }) {
  return (
    <Section id="workspace-heading" title="Workspace" tone="panel" gap={4}>
      <div className="flex flex-col gap-1">
        <span className={label}>Name</span>
        <p className="text-sm">{name}</p>
      </div>
      <p className="max-w-[70ch] text-sm text-muted-foreground">
        Rename this Workspace, create another or delete one on{" "}
        <Link href="/workspaces" className={textLink}>
          Workspaces
        </Link>
        . Deleting your account is on{" "}
        <Link href="/account" className={textLink}>
          Account
        </Link>
        .
      </p>
    </Section>
  );
}

const destinationKind = { telegram: "Telegram chat", email: "Email address", webhook: "Webhook" } as const;

/**
 * Where Source failing and Source recovered alerts go. A form of its own, so saving it can't be refused
 * by a field of the alert settings, and the other way round.
 */
async function HealthAlertsSection({ workspaceId, email }: { workspaceId: string; email: string }) {
  const options = await loadHealthAlertDestinations(server().db, workspaceId);
  return (
    <Section
      id="health-alerts-heading"
      title="Source Health alerts"
      tone="panel"
      gap={4}
      description="One alert goes out when a Source becomes failing, and one when it recovers. They wait for quiet hours and the hourly limit like any alert, and each goes as its own message."
    >
      {options.length === 0 ? (
        <p className="max-w-[70ch] text-sm">
          They go to <span className="break-all">{email}</span>, the address you sign in with. To send them somewhere
          else, add a Telegram chat or an email address on{" "}
          <Link href="/destinations" className={textLink}>
            Destinations
          </Link>
          , and it appears here once it&apos;s confirmed.
        </p>
      ) : (
        <form action={saveHealthAlertsAction} className="flex flex-col gap-4">
          <fieldset aria-describedby="health-alerts-help" className="flex flex-col gap-2">
            <legend className={cn(label, "mb-2")}>Send them to</legend>
            {options.map(({ id, name, type, named }) => (
              <CheckboxField
                key={id}
                id={`health-alerts-${id}`}
                name="destination"
                value={id}
                label={
                  <>
                    {name} <span className="pl-1 font-normal text-muted-foreground">{destinationKind[type]}</span>
                  </>
                }
                defaultChecked={named}
              />
            ))}
          </fieldset>
          <p id="health-alerts-help" className={cn(help, "max-w-[70ch]")}>
            With none ticked, they go to <span className="break-all">{email}</span>, the address you sign in with.
          </p>
          <SubmitButton variant="outline" pendingLabel="Saving…" className="sm:w-auto sm:self-start">
            Save Health alerts
          </SubmitButton>
        </form>
      )}
    </Section>
  );
}

/** Only the admin of a self-hosted install can open or close sign-up. */
async function SignupSection() {
  const open = (await server().db.query.instanceSettings.findFirst())?.signupOpen === true;
  return (
    <section
      aria-labelledby="sign-up"
      className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div aria-live="polite" className="flex flex-col gap-1">
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
