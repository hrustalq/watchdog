import { dataBox } from "@/components/field-classes";
import { CheckboxField, TextField } from "@/components/form-field";
import { Section } from "@/components/section";
import { cn } from "@/lib/utils";
import {
  type AlertSettings,
  type AlertSettingsField,
  alertsPerHourRange,
  burstWindowRange,
  type DeliverySettingsForm,
  quietHoursSentence,
  type RetentionSettingsForm,
  retentionRange,
  timezones,
} from "@/lib/settings";
import { saveDeliverySettingsAction, saveRetentionSettingsAction } from "./actions";
import { SettingsForm } from "./settings-form";
import { ZoneSuggestion } from "./zone-suggestion";

const help = "text-xs text-muted-foreground";

/** The order the Delivery form shows its fields in, which is the order the check names them in. */
const deliveryFields = ["timezone", "quietHoursStart", "quietHoursEnd", "alertsPerHour", "burstWindowSeconds"] as const;

/** The Retention form's fields, in its own order. */
const retentionFields = ["itemsRetentionDays", "logRetentionDays"] as const;

/**
 * The line over a refused form: it says that nothing was saved and points at the fields marked below.
 * It's inside the tab that posted, so a refusal never shows up beside another tab's unsaved fields.
 */
function Refused({ count }: { count: number }) {
  return (
    // Not focused like the saved notice: focus goes to the first field to fix.
    <p className="rounded-lg bg-muted px-3 py-2 text-sm">
      Nothing was saved. Fix the {count === 1 ? "field" : "fields"} marked below and save again.
    </p>
  );
}

/**
 * The Delivery tab: the timezone, quiet hours with the Severity 5 bypass, and the pacing, each in its
 * own panel so the set fills a desktop's width instead of stacking in one narrow column. Its form
 * posts alone, so saving it can't be refused by a Retention field or reset a retention window.
 */
export function DeliveryPanel({
  saved,
  values,
  errors,
  notice,
  hosted,
}: {
  /** The row as it's saved, which the quiet hours line and the timezone offer read. */
  saved: AlertSettings;
  values: DeliverySettingsForm;
  errors: Partial<Record<AlertSettingsField, string>>;
  notice?: string | undefined;
  /** A hosted install reads its daily email cap's day in the timezone too. */
  hosted: boolean;
}) {
  const errorFor = (name: AlertSettingsField) => errors[name];
  const firstError = deliveryFields.find((field) => errors[field] !== undefined);

  return (
    <>
      {firstError === undefined ? null : <Refused count={deliveryFields.filter((field) => errors[field] !== undefined).length} />}
      <SettingsForm
        action={saveDeliverySettingsAction}
        initial={values}
        notice={notice}
        submitLabel="Save delivery"
        note="A saved change applies to the next alert, including ones already waiting."
      >
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Section
            id="timezone-heading"
            title="Timezone"
            tone="panel"
            gap={4}
            descriptionId="timezone-help"
            description={
              <>
                Quiet hours and Digest schedules
                {hosted ? ", and the day of the daily email cap," : null} are read in this timezone. The Feed and the
                Log keep showing your device&apos;s time.
              </>
            }
          >
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
            tone="panel"
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

          <Section
            id="pacing-heading"
            title="Alert pacing"
            tone="panel"
            gap={4}
            description="Each Destination is paced on its own. Alerts that wait go out together as one Grouped alert."
          >
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
          </Section>
        </div>
      </SettingsForm>
    </>
  );
}

/**
 * The Retention tab: the Items window and the Log window, side by side on a screen with the room. Its
 * form posts alone, so saving it can't reset a Delivery setting.
 */
export function RetentionPanel({
  values,
  errors,
  notice,
  selfHosted,
}: {
  values: RetentionSettingsForm;
  errors: Partial<Record<AlertSettingsField, string>>;
  notice?: string | undefined;
  selfHosted: boolean;
}) {
  const errorFor = (name: AlertSettingsField) => errors[name];
  const firstError = retentionFields.find((field) => errors[field] !== undefined);

  return (
    <>
      {firstError === undefined ? null : <Refused count={retentionFields.filter((field) => errors[field] !== undefined).length} />}
      <SettingsForm
        action={saveRetentionSettingsAction}
        initial={values}
        notice={notice}
        submitLabel="Save retention"
        note="A saved window applies on the next sweep."
      >
        <Section
          id="retention-heading"
          title="Retention"
          tone="panel"
          gap={4}
          description={`The worker's sweep, once a minute, deletes what is older than these windows.${selfHosted ? " A self-hosted install can keep everything." : ""}`}
        >
          <div className="grid gap-4 sm:grid-cols-2">
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
          </div>
        </Section>
      </SettingsForm>
    </>
  );
}
