// The Workspace's alert settings, as the Settings screen changes them (docs: Actions and delivery,
// "Grouping and rate limits", "Quiet hours" and "Workspace timezone"). Delivery reads them each time it
// decides, so a save applies to the next decision.
import { z } from "zod";
import {
  and,
  type Db,
  delivery,
  destination,
  eq,
  healthAlertDestination,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type Tx,
  workspace,
} from "@watchdog/db";
import { isUuid } from "./uuid.ts";

/**
 * Every timezone the form offers, UTC first. Postgres can't check a name, so this list is the check.
 * Node's list leaves out UTC, the default.
 */
export const timezones = [...new Set(["UTC", ...Intl.supportedValuesOf("timeZone")])];
const knownTimezones = new Set(timezones);

/**
 * The listed name for a timezone, or undefined. A browser can name a zone by a newer or older name
 * than Node's list (Europe/Kyiv for Europe/Kiev), so a name is taken as the zone Intl reads it as.
 * An offset such as +03:00 reads as itself, which isn't listed.
 */
function listedTimezone(name: string) {
  if (knownTimezones.has(name)) return name;
  try {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: name }).resolvedOptions().timeZone;
    return knownTimezones.has(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

export const alertsPerHourRange = { min: 1, max: 1000 } as const;
export const burstWindowRange = { min: 0, max: 600 } as const;
/** A retention window in days: ten years is long enough that nothing real needs more. */
export const retentionRange = { min: 1, max: 3650 } as const;

/** What the form posts, as text, with each checkbox as whether it was ticked. */
export interface AlertSettingsForm {
  timezone: string;
  quietHours: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  severity5Bypasses: boolean;
  alertsPerHour: string;
  burstWindowSeconds: string;
  /** The day counts are inert while the matching "unlimited" box is ticked. */
  itemsRetentionDays: string;
  itemsUnlimited: boolean;
  logRetentionDays: string;
  logUnlimited: boolean;
}

export type AlertSettingsField =
  | "timezone"
  | "quietHoursStart"
  | "quietHoursEnd"
  | "alertsPerHour"
  | "burstWindowSeconds"
  | "itemsRetentionDays"
  | "logRetentionDays";

export interface AlertSettings {
  timezone: string;
  /** `HH:MM` as saved, or `HH:MM:SS` as Postgres reads it back. Both null when quiet hours are off. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  severity5BypassesQuietHours: boolean;
  alertsPerHour: number;
  burstWindowSeconds: number;
  /** How long the Workspace keeps its Items and its Log, in days. Null is unlimited. */
  itemsRetentionDays: number | null;
  logRetentionDays: number | null;
}

const time = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The alert settings form as the screen shows them: what's saved, with the defaults a new Workspace
 * starts from and each number as the text its field posts.
 */
export function settingsFormValues(settings: AlertSettings): AlertSettingsForm {
  return {
    timezone: settings.timezone,
    quietHours: settings.quietHoursStart !== null,
    // Off, the times are a suggestion, so turning quiet hours on is one tick.
    quietHoursStart: settings.quietHoursStart?.slice(0, 5) ?? "22:00",
    quietHoursEnd: settings.quietHoursEnd?.slice(0, 5) ?? "07:00",
    severity5Bypasses: settings.severity5BypassesQuietHours,
    alertsPerHour: String(settings.alertsPerHour),
    burstWindowSeconds: String(settings.burstWindowSeconds),
    // Unlimited leaves the day count inert, so it shows what a window would start from.
    itemsRetentionDays: String(settings.itemsRetentionDays ?? 90),
    itemsUnlimited: settings.itemsRetentionDays === null,
    logRetentionDays: String(settings.logRetentionDays ?? 30),
    logUnlimited: settings.logRetentionDays === null,
  };
}

/**
 * The Settings screen's tabs, in the order the strip shows them, each one a URL value. A tab is a
 * whole form's worth of settings: what one save writes and what one notice comes back on.
 */
export const settingsTabs = [
  { value: "delivery", label: "Delivery", adminOnly: false },
  { value: "retention", label: "Retention", adminOnly: false },
  { value: "health", label: "Health alerts", adminOnly: false },
  { value: "workspace", label: "Workspace", adminOnly: false },
  { value: "instance", label: "Instance", adminOnly: true },
] as const;

export type SettingsTab = (typeof settingsTabs)[number]["value"];

/**
 * The tab a URL asks for. Delivery is what `/settings` and a link with no tab show, and an unknown
 * value, a repeated one or Instance for anyone but an admin falls back to it, so a stale or edited
 * link opens the page rather than an empty one.
 */
export function resolveSettingsTab(value: unknown, { admin }: { admin: boolean }): SettingsTab {
  return settingsTabs.find((tab) => tab.value === value && (admin || !tab.adminOnly))?.value ?? "delivery";
}

/** The tabs this user may open: the Instance switch is the install admin's alone. */
export function settingsTabsFor(admin: boolean): readonly (typeof settingsTabs)[number][] {
  return settingsTabs.filter((tab) => admin || !tab.adminOnly);
}

/** A tab's URL. Every tab carries its value, so no link leans on the default. */
export function settingsTabHref(tab: SettingsTab) {
  return `/settings?tab=${tab}`;
}

/** The Delivery tab's form: the timezone, quiet hours with its bypass, and the pacing. */
export type DeliverySettingsForm = Pick<
  AlertSettingsForm,
  "timezone" | "quietHours" | "quietHoursStart" | "quietHoursEnd" | "severity5Bypasses" | "alertsPerHour" | "burstWindowSeconds"
>;

/** The Retention tab's form: the two windows, and their Unlimited boxes on a self-hosted install. */
export type RetentionSettingsForm = Pick<
  AlertSettingsForm,
  "itemsRetentionDays" | "itemsUnlimited" | "logRetentionDays" | "logUnlimited"
>;

function whole(text: string, { min, max }: { min: number; max: number }) {
  if (!/^\d{1,4}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

/**
 * A retention window, in whole days, or null for unlimited. Unlimited is a self-hosted install's to
 * choose: a hosted plan keeps the defaults as its free limits, so a posted null there is refused.
 */
function retentionDays(days: string, unlimited: boolean, selfHosted: boolean) {
  if (unlimited) {
    if (!selfHosted) {
      return { error: "Unlimited is only for a self-hosted install: choose a number of days." } as const;
    }
    return { days: null } as const;
  }
  const value = whole(days, retentionRange);
  if (value === undefined) {
    return { error: "Enter a whole number of days from 1 to 3,650, or tick Unlimited." } as const;
  }
  return { days: value } as const;
}

/** Every field a refusal can name, in the order the form shows them. */
const settingsFields: readonly AlertSettingsField[] = [
  "timezone",
  "quietHoursStart",
  "quietHoursEnd",
  "alertsPerHour",
  "burstWindowSeconds",
  "itemsRetentionDays",
  "logRetentionDays",
];

const isSettingsField = (value: string): value is AlertSettingsField =>
  settingsFields.some((field) => field === value);

const alertSettingsForm = z.object({
  timezone: z.string(),
  quietHours: z.boolean(),
  quietHoursStart: z.string(),
  quietHoursEnd: z.string(),
  severity5Bypasses: z.boolean(),
  alertsPerHour: z.string(),
  burstWindowSeconds: z.string(),
  itemsRetentionDays: z.string(),
  itemsUnlimited: z.boolean(),
  logRetentionDays: z.string(),
  logUnlimited: z.boolean(),
});

const alertSettingsSchema = (selfHosted: boolean) =>
  alertSettingsForm
    .superRefine((form, ctx) => {
      const refuse = (field: string, message: string) => {
        ctx.addIssue({ code: "custom", path: [field], message });
      };
      if (listedTimezone(form.timezone.trim()) === undefined) {
        refuse("timezone", "Choose a timezone from the list, such as Europe/Berlin or UTC.");
      }
      if (form.quietHours) {
        // The browser's time control posts HH:MM whatever clock it shows, so only a bad request gets here.
        if (!time.test(form.quietHoursStart)) refuse("quietHoursStart", "Choose when quiet hours start.");
        if (!time.test(form.quietHoursEnd)) refuse("quietHoursEnd", "Choose when quiet hours end.");
        else if (form.quietHoursEnd === form.quietHoursStart) {
          refuse("quietHoursEnd", "End quiet hours at a different time than they start.");
        }
      }
      if (whole(form.alertsPerHour, alertsPerHourRange) === undefined) {
        refuse("alertsPerHour", "Enter a whole number from 1 to 1,000.");
      }
      if (whole(form.burstWindowSeconds, burstWindowRange) === undefined) {
        refuse("burstWindowSeconds", "Enter a whole number of seconds from 0 to 600.");
      }
      const items = retentionDays(form.itemsRetentionDays, form.itemsUnlimited, selfHosted);
      if ("error" in items) refuse("itemsRetentionDays", items.error);
      const log = retentionDays(form.logRetentionDays, form.logUnlimited, selfHosted);
      if ("error" in log) refuse("logRetentionDays", log.error);
    })
    .transform((form) => ({
      timezone: form.timezone,
      quietHoursStart: form.quietHours ? form.quietHoursStart : null,
      quietHoursEnd: form.quietHours ? form.quietHoursEnd : null,
      severity5BypassesQuietHours: form.severity5Bypasses,
      alertsPerHour: Number(form.alertsPerHour),
      burstWindowSeconds: Number(form.burstWindowSeconds),
      itemsRetentionDays: form.itemsUnlimited ? null : Number(form.itemsRetentionDays),
      logRetentionDays: form.logUnlimited ? null : Number(form.logRetentionDays),
    }));

/** The form as the Workspace's columns, or what's wrong with each field that's wrong. */
export function parseAlertSettings(
  form: AlertSettingsForm,
  { selfHosted = false }: { selfHosted?: boolean } = {},
): { values: AlertSettings } | { errors: Partial<Record<AlertSettingsField, string>> } {
  const parsed = alertSettingsSchema(selfHosted).safeParse(form);
  if (!parsed.success) {
    const errors: Partial<Record<AlertSettingsField, string>> = {};
    for (const issue of parsed.error.issues) {
      const [field] = issue.path;
      if (typeof field === "string" && isSettingsField(field) && errors[field] === undefined) {
        errors[field] = issue.message;
      }
    }
    return { errors };
  }
  // The schema accepted the name; the Workspace stores the one it resolves to.
  const timezone = listedTimezone(parsed.data.timezone.trim());
  if (timezone === undefined) {
    return { errors: { timezone: "Choose a timezone from the list, such as Europe/Berlin or UTC." } };
  }
  return { values: { ...parsed.data, timezone } };
}

export async function loadAlertSettings(db: Db | Tx, workspaceId: string): Promise<AlertSettings> {
  const [row] = await db
    .select({
      timezone: workspace.timezone,
      quietHoursStart: workspace.quietHoursStart,
      quietHoursEnd: workspace.quietHoursEnd,
      severity5BypassesQuietHours: workspace.severity5BypassesQuietHours,
      alertsPerHour: workspace.alertsPerHour,
      burstWindowSeconds: workspace.burstWindowSeconds,
      itemsRetentionDays: workspace.itemsRetentionDays,
      logRetentionDays: workspace.logRetentionDays,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  if (row === undefined) throw new Error(`No Workspace ${workspaceId}`);
  return row;
}

/** What a save answers: it went through, or the fields that are wrong, in the form's order. */
type SaveSettingsResult = { saved: true } | { errors: Partial<Record<AlertSettingsField, string>> };

/**
 * One tab's columns: the ones its save writes, and the row as it stands afterwards, which is how the
 * hold check sees a change to a setting it times.
 */
type TabColumns = (before: AlertSettings, values: AlertSettings) => {
  write: Partial<typeof workspace.$inferInsert>;
  after: AlertSettings;
};

/** What a Delivery save writes, leaving the Retention tab's windows as they are. */
const deliveryTab: TabColumns = (before, values) => {
  const write = {
    timezone: values.timezone,
    quietHoursStart: values.quietHoursStart,
    quietHoursEnd: values.quietHoursEnd,
    severity5BypassesQuietHours: values.severity5BypassesQuietHours,
    alertsPerHour: values.alertsPerHour,
    burstWindowSeconds: values.burstWindowSeconds,
  };
  return { write, after: { ...before, ...write } };
};

/** What a Retention save writes, and the row afterwards. A window doesn't time a hold, so this one
 * changes none. */
const retentionTab: TabColumns = (before, values) => {
  const write = { itemsRetentionDays: values.itemsRetentionDays, logRetentionDays: values.logRetentionDays };
  return { write, after: { ...before, ...write } };
};

/**
 * Saves one tab, and only that tab's columns. The form is checked against what's saved for every
 * field the tab doesn't own, so a save can't be refused by a field it never showed, and the columns
 * it doesn't write stay as they are. The bookkeeping columns a save is never about
 * (`emailCapNoticeUntil`, `confirmationMailAt`) are not among them and are left alone.
 */
async function saveTab(
  db: Db,
  workspaceId: string,
  form: (saved: AlertSettings) => AlertSettingsForm,
  tab: TabColumns,
  { selfHosted = false }: { selfHosted?: boolean } = {},
): Promise<SaveSettingsResult> {
  return db.transaction(async (tx) => {
    const before = await loadAlertSettings(tx, workspaceId);
    const parsed = parseAlertSettings(form(before), { selfHosted });
    if ("errors" in parsed) return parsed;
    const { write, after } = tab(before, parsed.values);
    await tx.update(workspace).set(write).where(eq(workspace.id, workspaceId));
    // In the transaction that saves it, so a sweep that runs meanwhile can't read the new settings beside
    // the old hold times and leave a row waiting for a time the settings no longer name.
    if (changesHolds(before, after)) await releaseHeldDeliveries(tx, workspaceId);
    return { saved: true as const };
  });
}

/**
 * Saves the Delivery tab: the timezone, quiet hours and the Severity 5 bypass, and the pacing. The
 * Retention tab's windows are read back from the row to be checked, and never written.
 */
export async function saveDeliverySettings(
  db: Db,
  workspaceId: string,
  form: DeliverySettingsForm,
  options: { selfHosted?: boolean } = {},
): Promise<SaveSettingsResult> {
  // Only this tab's fields, so anything else a post carries is dropped before the check and the write.
  const posted: DeliverySettingsForm = {
    timezone: form.timezone,
    quietHours: form.quietHours,
    quietHoursStart: form.quietHoursStart,
    quietHoursEnd: form.quietHoursEnd,
    severity5Bypasses: form.severity5Bypasses,
    alertsPerHour: form.alertsPerHour,
    burstWindowSeconds: form.burstWindowSeconds,
  };
  return saveTab(db, workspaceId, (saved) => ({ ...settingsFormValues(saved), ...posted }), deliveryTab, options);
}

/**
 * Saves the Retention tab: the two windows. Everything the Delivery tab owns is read back from the
 * row to be checked, and never written.
 */
export async function saveRetentionSettings(
  db: Db,
  workspaceId: string,
  form: RetentionSettingsForm,
  options: { selfHosted?: boolean } = {},
): Promise<SaveSettingsResult> {
  const posted: RetentionSettingsForm = {
    itemsRetentionDays: form.itemsRetentionDays,
    itemsUnlimited: form.itemsUnlimited,
    logRetentionDays: form.logRetentionDays,
    logUnlimited: form.logUnlimited,
  };
  return saveTab(db, workspaceId, (saved) => ({ ...settingsFormValues(saved), ...posted }), retentionTab, options);
}

/** A quiet hours time to the minute, as the form posts it and the user set it. Postgres reads it back with seconds. */
const toTheMinute = (value: string | null) => (value === null ? null : value.slice(0, 5));

/**
 * Whether a save changes a setting a hold is timed by: quiet hours, the Severity 5 bypass, the rate limit,
 * the burst window or the timezone. A tight or loose change both count, because either may move the hold's
 * time, and the row is only made due: `deliver` holds it again at the right time if it still has to wait.
 */
export function changesHolds(before: AlertSettings, after: AlertSettings) {
  return (
    before.timezone !== after.timezone ||
    toTheMinute(before.quietHoursStart) !== toTheMinute(after.quietHoursStart) ||
    toTheMinute(before.quietHoursEnd) !== toTheMinute(after.quietHoursEnd) ||
    before.severity5BypassesQuietHours !== after.severity5BypassesQuietHours ||
    before.alertsPerHour !== after.alertsPerHour ||
    before.burstWindowSeconds !== after.burstWindowSeconds
  );
}

/**
 * Makes the Workspace's held and grouped Deliveries due, so the worker's next sweep queues them and
 * `deliver` checks each against the settings as saved (docs: Actions and delivery, "Deliveries").
 *
 * A row the hosted email cap holds keeps its time: the cap isn't a setting, so nothing a save changes can
 * let the row go before the next local day. Releasing it would only hold it again at the same time, with a
 * second "Held until" row in its Log.
 */
async function releaseHeldDeliveries(tx: Tx, workspaceId: string) {
  const itsDestinations = tx
    .select({ id: destination.id })
    .from(destination)
    .where(eq(destination.workspaceId, workspaceId));
  await tx
    .update(delivery)
    .set({ nextAttemptAt: sql`now()` })
    .where(
      and(
        inArray(delivery.status, ["held", "grouped"]),
        inArray(delivery.destinationId, itsDestinations),
        or(isNull(delivery.holdReason), ne(delivery.holdReason, "email-cap")),
      ),
    );
}

/** Quiet hours in words, as the user set them. */
export function quietHoursSentence(
  settings: Pick<AlertSettings, "timezone" | "quietHoursStart" | "quietHoursEnd" | "severity5BypassesQuietHours">,
) {
  const { quietHoursStart: start, quietHoursEnd: end, timezone } = settings;
  if (start === null || end === null) return "Alerts go as soon as they're due, at any hour.";
  const held = `Alerts are held from ${start.slice(0, 5)} to ${end.slice(0, 5)} ${timezone}.`;
  return settings.severity5BypassesQuietHours ? `${held} Severity 5 alerts still go at once.` : held;
}

/** What a form or a query holds for a name, as text. A missing or repeated field reads as empty. */
function postedText(get: (name: string) => unknown) {
  return (name: string) => {
    const value = get(name);
    return typeof value === "string" ? value : "";
  };
}

/** The Delivery form from what it posted, or from the query a refused save sends it back with. */
export function readDeliverySettingsForm(get: (name: string) => unknown): DeliverySettingsForm {
  const text = postedText(get);
  return {
    timezone: text("timezone"),
    quietHours: text("quietHours") === "on",
    quietHoursStart: text("quietHoursStart"),
    quietHoursEnd: text("quietHoursEnd"),
    severity5Bypasses: text("severity5Bypasses") === "on",
    alertsPerHour: text("alertsPerHour"),
    burstWindowSeconds: text("burstWindowSeconds"),
  };
}

/** The Retention form from what it posted, or from the query a refused save sends it back with. */
export function readRetentionSettingsForm(get: (name: string) => unknown): RetentionSettingsForm {
  const text = postedText(get);
  return {
    itemsRetentionDays: text("itemsRetentionDays"),
    itemsUnlimited: text("itemsUnlimited") === "on",
    logRetentionDays: text("logRetentionDays"),
    logUnlimited: text("logUnlimited") === "on",
  };
}

/**
 * The query that brings a refused Delivery form back as it was posted, on its own tab. It carries
 * that tab's values and no other's, so opening the link can't reset a setting the user didn't post.
 */
export function deliveryRefusalQuery(form: DeliverySettingsForm) {
  return new URLSearchParams({
    tab: "delivery",
    refused: "1",
    timezone: form.timezone,
    quietHoursStart: form.quietHoursStart,
    quietHoursEnd: form.quietHoursEnd,
    alertsPerHour: form.alertsPerHour,
    burstWindowSeconds: form.burstWindowSeconds,
    ...(form.quietHours ? { quietHours: "on" } : {}),
    ...(form.severity5Bypasses ? { severity5Bypasses: "on" } : {}),
  }).toString();
}

/** The query that brings a refused Retention form back as it was posted, on its own tab. */
export function retentionRefusalQuery(form: RetentionSettingsForm) {
  return new URLSearchParams({
    tab: "retention",
    refused: "1",
    itemsRetentionDays: form.itemsRetentionDays,
    logRetentionDays: form.logRetentionDays,
    ...(form.itemsUnlimited ? { itemsUnlimited: "on" } : {}),
    ...(form.logUnlimited ? { logUnlimited: "on" } : {}),
  }).toString();
}

/**
 * The Destinations the Health alerts setting can name: the Workspace's confirmed Telegram chats and email
 * addresses (docs: Actions and delivery, "Source Health alerts"). `named` says the setting names it now.
 */
export async function loadHealthAlertDestinations(db: Db, workspaceId: string) {
  const rows = await db
    .select({
      id: destination.id,
      name: destination.name,
      type: destination.type,
      named: healthAlertDestination.destinationId,
    })
    .from(destination)
    .leftJoin(healthAlertDestination, eq(healthAlertDestination.destinationId, destination.id))
    .where(
      and(
        eq(destination.workspaceId, workspaceId),
        inArray(destination.type, ["telegram", "email"]),
        isNotNull(destination.confirmedAt),
      ),
    )
    .orderBy(destination.name);
  return rows.map((row) => ({ ...row, named: row.named !== null }));
}

/**
 * Names these Destinations in the Health alerts setting, and no others. The ids come from a form, so any
 * that isn't one of the Workspace's confirmed Telegram chats or email addresses is left out. With none,
 * the alerts go to the sign-in address.
 */
export async function saveHealthAlertDestinations(db: Db, workspaceId: string, destinationIds: string[]) {
  const ids = destinationIds.filter(isUuid);
  await db.transaction(async (tx) => {
    // The Destinations first, as a remove takes them, so the two can't deadlock. Shared, so a remove
    // of one waits rather than fail this insert's foreign key.
    const allowed =
      ids.length === 0
        ? []
        : await tx
            .select({ destinationId: destination.id })
            .from(destination)
            .where(
              and(
                eq(destination.workspaceId, workspaceId),
                inArray(destination.id, ids),
                inArray(destination.type, ["telegram", "email"]),
                isNotNull(destination.confirmedAt),
              ),
            )
            .orderBy(destination.id)
            .for("key share");
    await tx.delete(healthAlertDestination).where(eq(healthAlertDestination.workspaceId, workspaceId));
    if (allowed.length === 0) return;
    // Two saves at once can both insert a row, and either is what the user asked for.
    await tx
      .insert(healthAlertDestination)
      .values(allowed.map(({ destinationId }) => ({ workspaceId, destinationId })))
      .onConflictDoNothing();
  });
}
