import type { Metadata } from "next";
import Link from "next/link";
import { dataBox, field, label, textLink } from "@/components/field-classes";
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
  timezones,
} from "@/lib/settings";
import { cn } from "@/lib/utils";
import { FieldError } from "../destinations/field-error";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { saveHealthAlertsAction, setSignup } from "./actions";
import { SettingsForm } from "./settings-form";
import { ZoneSuggestion } from "./zone-suggestion";

export const metadata: Metadata = { title: "Settings · Watchdog" };

// The data is read without Suspense, so the forms and what's wrong with them are in the first HTML, which
// is how they work without JavaScript. In a static shell, an empty form could replace the saved settings.
export const instant = false;

const checkbox =
  "size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const help = "text-xs text-muted-foreground";

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const [{ user, workspace, admin }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const { db, mode } = server();
  const saved = await loadAlertSettings(db, workspace.id);

  // A refused save comes back with the form as it was posted, and what's wrong is read from it again.
  // A link whose values pass the check isn't a refusal, so the form shows what's saved, not its values.
  const posted = params.refused === "1" ? readAlertSettingsForm((name) => params[name]) : undefined;
  const parsed = posted === undefined ? undefined : parseAlertSettings(posted);
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
  };
  // The check finds problems in the form's order.
  const firstError = Object.keys(errors)[0];
  const fieldProps = (name: AlertSettingsField, id: string, hint: string) => {
    const error = errors[name];
    return {
      id,
      name,
      defaultValue: values[name],
      "aria-invalid": error !== undefined,
      "aria-describedby": error === undefined ? hint : `${id}-error ${hint}`,
      // Focus lands on the first field to fix, so the field and its message are read together.
      autoFocus: name === firstError,
    };
  };
  const errorFor = (name: AlertSettingsField, id: string) => {
    const error = errors[name];
    return error === undefined ? null : <FieldError id={`${id}-error`}>{error}</FieldError>;
  };

  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link
          href="/"
          className="inline-flex min-h-6 items-center rounded-sm text-muted-foreground underline-offset-4 outline-hidden hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          Workspace
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span aria-current="page">Settings</span>
      </nav>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8">
        <h1 className="text-headline">Settings</h1>

        {params.saved === "health" ? (
          <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
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
          <div className="flex flex-col divide-y rounded-lg border">
            <section aria-labelledby="timezone-heading" className="flex flex-col gap-4 p-4">
              <div className="flex flex-col gap-1">
                <h2 id="timezone-heading" className="text-title">
                  Timezone
                </h2>
                <p id="timezone-help" className="max-w-[70ch] text-sm text-muted-foreground">
                  Quiet hours and Digest schedules
                  {mode === "hosted" ? ", and the day of the daily email cap," : null} are read in this timezone. The
                  Feed and the Log keep showing your device&apos;s time.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="timezone" className={label}>
                  IANA timezone
                </label>
                <input
                  {...fieldProps("timezone", "timezone", "timezone-help")}
                  type="text"
                  list="timezones"
                  required
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Europe/Berlin"
                  className={cn(field, dataBox, "sm:max-w-xs")}
                />
                <datalist id="timezones">
                  {timezones.map((zone) => (
                    <option key={zone} value={zone} />
                  ))}
                </datalist>
                {errorFor("timezone", "timezone")}
                <ZoneSuggestion inputId="timezone" saved={saved.timezone} />
              </div>
            </section>

            <section aria-labelledby="quiet-hours-heading" className="flex flex-col gap-4 p-4">
              <div className="flex flex-col gap-1">
                <h2 id="quiet-hours-heading" className="text-title">
                  Quiet hours
                </h2>
                <p className="text-sm">
                  {/* A refused form below can say otherwise, so this says it's what's saved. */}
                  {firstError === undefined ? null : <span className="text-muted-foreground">Saved: </span>}
                  {quietHoursSentence(saved)}
                </p>
                <p id="quiet-hours-help" className="max-w-[70ch] text-sm text-muted-foreground">
                  Alerts due inside quiet hours are held, never dropped, and go when they end, as one Grouped alert per
                  Destination. Webhooks and Digests ignore them.
                </p>
              </div>
              {/* The label holds the box, so the whole row is the target. */}
              <label htmlFor="quiet-hours" className={cn(label, "flex min-h-6 items-center gap-2")}>
                <input
                  id="quiet-hours"
                  name="quietHours"
                  type="checkbox"
                  defaultChecked={values.quietHours}
                  aria-describedby="quiet-hours-help"
                  className={checkbox}
                />
                Hold alerts during quiet hours
              </label>
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
                    <div key={id} className="flex min-w-0 flex-col gap-2">
                      <label htmlFor={id} className={label}>
                        {title}
                      </label>
                      <input
                        {...fieldProps(name, id, "quiet-times-help")}
                        type="time"
                        className={cn(field, dataBox, "tabular-nums")}
                      />
                      {errorFor(name, id)}
                    </div>
                  ))}
                  <p id="quiet-times-help" className={cn(help, "col-span-2")}>
                    In the timezone above. A start later than the end runs past midnight.
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="severity-5-bypasses" className={cn(label, "flex min-h-6 items-center gap-2")}>
                    <input
                      id="severity-5-bypasses"
                      name="severity5Bypasses"
                      type="checkbox"
                      defaultChecked={values.severity5Bypasses}
                      aria-describedby="severity-5-bypasses-help"
                      className={checkbox}
                    />
                    Let Severity 5 alerts through
                  </label>
                  <p id="severity-5-bypasses-help" className={cn(help, "pl-6")}>
                    A Severity 5 alert goes at once, even in quiet hours. The rest still wait.
                  </p>
                </div>
              </div>
            </section>

            <section aria-labelledby="pacing-heading" className="flex flex-col gap-4 p-4">
              <div className="flex flex-col gap-1">
                <h2 id="pacing-heading" className="text-title">
                  Alert pacing
                </h2>
                <p className="max-w-[70ch] text-sm text-muted-foreground">
                  Each Destination is paced on its own. Alerts that wait go out together as one Grouped alert.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label htmlFor="alerts-per-hour" className={label}>
                    Alerts per hour
                  </label>
                  <input
                    {...fieldProps("alertsPerHour", "alerts-per-hour", "alerts-per-hour-help")}
                    type="number"
                    required
                    min={alertsPerHourRange.min}
                    max={alertsPerHourRange.max}
                    step={1}
                    inputMode="numeric"
                    className={cn(field, dataBox, "tabular-nums sm:max-w-40")}
                  />
                  {errorFor("alertsPerHour", "alerts-per-hour")}
                  <p id="alerts-per-hour-help" className={help}>
                    From 1 to 1,000, 20 by default. Past the limit, alerts wait until the oldest leaves the hour.
                  </p>
                </div>
                <div className="flex flex-col gap-2">
                  <label htmlFor="burst-window" className={label}>
                    Burst window, in seconds
                  </label>
                  <input
                    {...fieldProps("burstWindowSeconds", "burst-window", "burst-window-help")}
                    type="number"
                    required
                    min={burstWindowRange.min}
                    max={burstWindowRange.max}
                    step={1}
                    inputMode="numeric"
                    className={cn(field, dataBox, "tabular-nums sm:max-w-40")}
                  />
                  {errorFor("burstWindowSeconds", "burst-window")}
                  <p id="burst-window-help" className={help}>
                    From 0 to 600, 60 by default. Alerts due within this time of the last one wait and go together. At 0
                    each alert goes on its own.
                  </p>
                </div>
              </div>
            </section>
          </div>
        </SettingsForm>

        <HealthAlertsSection workspaceId={workspace.id} email={user.email} />

        {admin ? <SignupSection /> : null}
      </main>
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
    <section aria-labelledby="health-alerts-heading" className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <h2 id="health-alerts-heading" className="text-title">
          Source Health alerts
        </h2>
        <p className="max-w-[70ch] text-sm text-muted-foreground">
          One alert goes out when a Source becomes failing, and one when it recovers. They wait for quiet hours and
          the hourly limit like any alert, and each goes as its own message.
        </p>
      </div>
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
              <label key={id} htmlFor={`health-alerts-${id}`} className={cn(label, "flex min-h-6 items-center gap-2")}>
                <input
                  id={`health-alerts-${id}`}
                  name="destination"
                  value={id}
                  type="checkbox"
                  defaultChecked={named}
                  className={checkbox}
                />
                {/* One run of text with a real space: Chrome drops the gap between sibling spans from the name. */}
                <span className="min-w-0 break-words">
                  {name} <span className="pl-1 font-normal text-muted-foreground">{destinationKind[type]}</span>
                </span>
              </label>
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
    </section>
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
