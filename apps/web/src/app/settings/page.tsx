import type { Metadata } from "next";
import Link from "next/link";
import { dataBox, label, textLink } from "@/components/field-classes";
import { CheckboxField, TextField } from "@/components/form-field";
import { Notice } from "@/components/notice";
import { PageBar } from "@/components/page-bar";
import { Page, PageHeader } from "@/components/page";
import { PanelList } from "@/components/panel-list";
import { Section } from "@/components/section";
import { requireWorkspace, server } from "@/lib/server";
import {
  type AlertSettingsField,
  type AlertSettingsForm,
  alertsPerHourRange,
  burstWindowRange,
  loadAlertSettings,
  loadHealthAlertDestinations,
  parseAlertSettings,
  quietHoursSentence,
  readAlertSettingsForm,
  retentionRange,
  timezones,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { SubmitButton } from "@/components/submit-button";
import { deleteWorkspaceAction, saveHealthAlertsAction, setSignup } from "./actions";
import { SettingsForm } from "./settings-form";
import { ZoneSuggestion } from "./zone-suggestion";

export const metadata: Metadata = { title: "Settings · Watchdog" };

// The data is read without Suspense, so the forms and what's wrong with them are in the first HTML, which
// is how they work without JavaScript. In a static shell, an empty form could replace the saved settings.
export const instant = false;

const help = "text-xs text-muted-foreground";

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const [{ user, workspace, admin }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const { db, mode } = server();
  const selfHosted = mode === "self-hosted";
  const saved = await loadAlertSettings(db, workspace.id);

  // A refused save comes back with the form as it was posted, and what's wrong is read from it again.
  // A link whose values pass the check isn't a refusal, so the form shows what's saved, not its values.
  const posted = params.refused === "1" ? readAlertSettingsForm((name) => params[name]) : undefined;
  const parsed = posted === undefined ? undefined : parseAlertSettings(posted, { selfHosted });
  const errors = parsed !== undefined && "errors" in parsed ? parsed.errors : {};
  const refused = Object.keys(errors).length > 0 ? posted : undefined;
  const values: AlertSettingsForm = refused ?? {
    timezone: saved.timezone,
    quietHours: saved.quietHoursStart !== null,
    // Off, the times are a suggestion, so turning quiet hours on is one tick.
    quietHoursStart: saved.quietHoursStart?.slice(0, 5) ?? "22:00",
    quietHoursEnd: saved.quietHoursEnd?.slice(0, 5) ?? "07:00",
    severity5Bypasses: saved.severity5BypassesQuietHours,
    alertsPerHour: String(saved.alertsPerHour),
    burstWindowSeconds: String(saved.burstWindowSeconds),
    // Unlimited leaves the day count inert, so it shows what a window would start from.
    itemsRetentionDays: String(saved.itemsRetentionDays ?? 90),
    itemsUnlimited: saved.itemsRetentionDays === null,
    logRetentionDays: String(saved.logRetentionDays ?? 30),
    logUnlimited: saved.logRetentionDays === null,
  };
  // The check finds problems in the form's order.
  const firstError = Object.keys(errors)[0];
  const errorFor = (name: AlertSettingsField) => errors[name];

  return (
    <div className="flex flex-1 flex-col">
      <PageBar trail={[{ href: "/", label: "Workspace" }, { label: "Settings" }]} />
      <Page width="narrow" gap={6}>
        <PageHeader title="Settings" />

        {params.saved === "health" ? (
          <Notice role="status">
            Source Health alerts saved. The next one follows them.
          </Notice>
        ) : null}
        {firstError === undefined ? null : (
          // Not focused like the saved notice: focus goes to the first field to fix.
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">
            Nothing was saved. Fix the {Object.keys(errors).length === 1 ? "field" : "fields"} marked below and save
            again.
          </p>
        )}

        {/* A new key for each redirect remounts the fields, so with JavaScript too the first one to fix takes
            focus, its message is announced, and a saved form starts from what's saved. */}
        <SettingsForm
          key={JSON.stringify(params)}
          initial={values}
          justSaved={params.saved === "1" && refused === undefined}
        >
          <PanelList as="div">
            <Section id="timezone-heading" title="Timezone" tone="inset" gap={4} descriptionId="timezone-help" description={
              <>
                Quiet hours and Digest schedules
                {mode === "hosted" ? ", and the day of the daily email cap," : null} are read in this timezone. The
                Feed and the Log keep showing your device&apos;s time.
              </>
            }>
              <TextField
                id="timezone"
                label="IANA timezone"
                defaultValue={values.timezone}
                error={errorFor("timezone")}
                describedBy="timezone-help"
                type="text"
                list="timezones"
                required
                autoComplete="off"
                placeholder="Europe/Berlin"
                controlClassName={cn(dataBox, "sm:max-w-xs")}
              />
              <datalist id="timezones">
                {timezones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              <ZoneSuggestion inputId="timezone" saved={saved.timezone} />
            </Section>

            <Section
              id="quiet-hours-heading"
              title="Quiet hours"
              tone="inset"
              gap={4}
              descriptionClassName="text-foreground"
              description={
                <>
                  {/* A refused form below can say otherwise, so this says it's what's saved. */}
                  {firstError === undefined ? null : <span className="text-muted-foreground">Saved: </span>}
                  {quietHoursSentence(saved)}
                </>
              }
            >
              <p id="quiet-hours-help" className="max-w-[70ch] text-xs text-muted-foreground">
                Alerts due inside quiet hours are held, never dropped, and go when they end, as one Grouped alert per
                Destination. Webhooks and Digests ignore them.
              </p>
              <CheckboxField
                id="quiet-hours"
                name="quietHours"
                label="Hold alerts during quiet hours"
                defaultChecked={values.quietHours}
                aria-describedby="quiet-hours-help"
              />
              {/* Dimmed while quiet hours are off, without JavaScript too. They stay usable, so the times
                  can be set before the box is ticked. */}
              <div className="flex flex-col gap-4 transition-opacity [section:has(#quiet-hours:not(:checked))_&]:opacity-60">
                <div className="grid grid-cols-2 gap-4 sm:max-w-xs">
                  {(
                    [
                      ["quietHoursStart", "quiet-start", "From"],
                      ["quietHoursEnd", "quiet-end", "Until"],
                    ] as const
                  ).map(([name, id, title]) => (
                    <TextField
                      key={id}
                      id={id}
                      name={name}
                      label={title}
                      type="time"
                      defaultValue={values[name]}
                      error={errorFor(name)}
                      describedBy="quiet-times-help"
                      focusOnError={name === firstError}
                      controlClassName={cn(dataBox, "tabular-nums")}
                    />
                  ))}
                  <p id="quiet-times-help" className={cn(help, "col-span-2")}>
                    In the timezone above. A start later than the end runs past midnight.
                  </p>
                </div>
                <CheckboxField
                  id="severity-5-bypasses"
                  name="severity5Bypasses"
                  label="Let Severity 5 alerts through"
                  defaultChecked={values.severity5Bypasses}
                  help="A Severity 5 alert goes at once, even in quiet hours. The rest still wait."
                />
              </div>
            </Section>

            <Section id="pacing-heading" title="Alert pacing" tone="inset" gap={4} description="Each Destination is paced on its own. Alerts that wait go out together as one Grouped alert.">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField
                  id="alerts-per-hour"
                  name="alertsPerHour"
                  label="Alerts per hour"
                  type="number"
                  required
                  min={alertsPerHourRange.min}
                  max={alertsPerHourRange.max}
                  step={1}
                  inputMode="numeric"
                  defaultValue={values.alertsPerHour}
                  error={errorFor("alertsPerHour")}
                  focusOnError={firstError === "alertsPerHour"}
                  controlClassName={cn(dataBox, "tabular-nums sm:max-w-40")}
                  showHelpWithError
                  help="From 1 to 1,000, 20 by default. Past the limit, alerts wait until the oldest leaves the hour."
                />
                <TextField
                  id="burst-window"
                  name="burstWindowSeconds"
                  label="Burst window, in seconds"
                  type="number"
                  required
                  min={burstWindowRange.min}
                  max={burstWindowRange.max}
                  step={1}
                  inputMode="numeric"
                  defaultValue={values.burstWindowSeconds}
                  error={errorFor("burstWindowSeconds")}
                  focusOnError={firstError === "burstWindowSeconds"}
                  controlClassName={cn(dataBox, "tabular-nums sm:max-w-40")}
                  showHelpWithError
                  help="From 0 to 600, 60 by default. Alerts due within this time of the last one wait and go together. At 0 each alert goes on its own."
                />
              </div>
            </Section>

            <Section
              id="retention-heading"
              title="Retention"
              tone="inset"
              gap={4}
              description={
                <>
                  The worker&apos;s sweep, once a minute, deletes what is older than these windows. A saved
                  window applies on the next sweep.{selfHosted ? " A self-hosted install can keep everything." : ""}
                </>
              }
            >
              {(
                [
                  ["itemsRetentionDays", "itemsUnlimited", "items-retention", "Items, in days"],
                  ["logRetentionDays", "logUnlimited", "log-retention", "Log, in days"],
                ] as const
              ).map(([name, unlimitedName, id, title]) => (
                <div key={id} className="flex flex-col gap-2">
                  <TextField
                    id={id}
                    name={name}
                    label={title}
                    type="number"
                    min={retentionRange.min}
                    max={retentionRange.max}
                    step={1}
                    inputMode="numeric"
                    defaultValue={values[name]}
                    error={errorFor(name)}
                    focusOnError={firstError === name}
                    controlClassName={cn(dataBox, "tabular-nums sm:max-w-40")}
                    showHelpWithError
                    help={`${
                      /* Both windows hold what is inside them, so the wording names what goes. */
                      name === "itemsRetentionDays"
                        ? "Older Items go, with their Log rows, Deliveries and Ratings. A Correction of one keeps the title and summary it copied."
                        : "Older Log rows go, even when their Item is newer. Deliveries follow this window."
                    } From 1 to 3,650 days.`}
                  />
                  {selfHosted ? (
                    <CheckboxField
                      id={`${id}-unlimited`}
                      name={unlimitedName}
                      label="Unlimited: keep everything"
                      defaultChecked={values[unlimitedName]}
                      help="Nothing of this is ever purged."
                    />
                  ) : null}
                </div>
              ))}
            </Section>
          </PanelList>
        </SettingsForm>

        <HealthAlertsSection workspaceId={workspace.id} email={user.email} />

        <DeleteWorkspaceSection name={workspace.name} email={user.email} refused={params.delete === "name"} />

        {admin ? <SignupSection /> : null}
      </Page>
    </div>
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

/**
 * Deletes the Workspace and the account with it, behind a confirmation that names the Workspace
 * (docs: Security and privacy, "Deleting and exporting a Workspace"). It's a form of its own, so
 * nothing else on the page can post it, and it works without JavaScript: the check is the server's.
 */
function DeleteWorkspaceSection({ name, email, refused }: { name: string; email: string; refused: boolean }) {
  return (
    <Section
      id="delete-heading"
      title="Delete Workspace"
      tone="panel"
      gap={4}
      description={
        <>
          This deletes the Workspace and everything in it in one go: its Sources, Items and their Log, Corrections,
          Rules, Destinations, Actions, Deliveries, Profile, model settings, Agent calls and Telegram connections. It
          deletes your account, <span className="break-all">{email}</span>, with them, so it signs you out. It can&apos;t
          be undone.
        </>
      }
    >
      {refused ? (
        <Notice role="alert">
          That isn&apos;t this Workspace&apos;s name, so nothing was deleted. Type <strong>{name}</strong> to confirm.
        </Notice>
      ) : null}
      <form action={deleteWorkspaceAction} className="flex flex-col gap-4">
        <TextField
          id="delete-name"
          name="name"
          label={<>Type {name} to confirm</>}
          type="text"
          required
          autoComplete="off"
          help="The Workspace's name, exactly as it is above."
          controlClassName={cn(dataBox, "sm:max-w-xs")}
        />
        <SubmitButton variant="destructive" pendingLabel="Deleting…" className="sm:w-auto sm:self-start">
          Delete Workspace
        </SubmitButton>
      </form>
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
