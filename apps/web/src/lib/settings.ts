// The Workspace's alert settings, as the Settings screen changes them (docs: Actions and delivery,
// "Grouping and rate limits", "Quiet hours" and "Workspace timezone"). Delivery reads them each time it
// decides, so a save applies to the next decision.
import { and, type Db, destination, eq, healthAlertDestination, inArray, isNotNull, or, workspace } from "@watchdog/db";
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

/** What the form posts, as text, with each checkbox as whether it was ticked. */
export interface AlertSettingsForm {
  timezone: string;
  quietHours: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  severity5Bypasses: boolean;
  alertsPerHour: string;
  burstWindowSeconds: string;
}

export type AlertSettingsField = "timezone" | "quietHoursStart" | "quietHoursEnd" | "alertsPerHour" | "burstWindowSeconds";

export interface AlertSettings {
  timezone: string;
  /** `HH:MM` as saved, or `HH:MM:SS` as Postgres reads it back. Both null when quiet hours are off. */
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  severity5BypassesQuietHours: boolean;
  alertsPerHour: number;
  burstWindowSeconds: number;
}

const time = /^([01]\d|2[0-3]):[0-5]\d$/;

function whole(text: string, { min, max }: { min: number; max: number }) {
  if (!/^\d{1,4}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

/** The form as the Workspace's columns, or what's wrong with each field that's wrong. */
export function parseAlertSettings(
  form: AlertSettingsForm,
): { values: AlertSettings } | { errors: Partial<Record<AlertSettingsField, string>> } {
  const errors: Partial<Record<AlertSettingsField, string>> = {};
  const timezone = listedTimezone(form.timezone.trim());
  if (timezone === undefined) {
    errors.timezone = "Choose a timezone from the list, such as Europe/Berlin or UTC.";
  }
  if (form.quietHours) {
    // The browser's time control posts HH:MM whatever clock it shows, so only a bad request gets here.
    if (!time.test(form.quietHoursStart)) errors.quietHoursStart = "Choose when quiet hours start.";
    if (!time.test(form.quietHoursEnd)) errors.quietHoursEnd = "Choose when quiet hours end.";
    else if (form.quietHoursEnd === form.quietHoursStart) {
      errors.quietHoursEnd = "End quiet hours at a different time than they start.";
    }
  }
  const alertsPerHour = whole(form.alertsPerHour, alertsPerHourRange);
  if (alertsPerHour === undefined) errors.alertsPerHour = "Enter a whole number from 1 to 1,000.";
  const burstWindowSeconds = whole(form.burstWindowSeconds, burstWindowRange);
  if (burstWindowSeconds === undefined) errors.burstWindowSeconds = "Enter a whole number of seconds from 0 to 600.";

  if (timezone === undefined || alertsPerHour === undefined || burstWindowSeconds === undefined || Object.keys(errors).length > 0) {
    return { errors };
  }
  return {
    values: {
      timezone,
      quietHoursStart: form.quietHours ? form.quietHoursStart : null,
      quietHoursEnd: form.quietHours ? form.quietHoursEnd : null,
      severity5BypassesQuietHours: form.severity5Bypasses,
      alertsPerHour,
      burstWindowSeconds,
    },
  };
}

export async function loadAlertSettings(db: Db, workspaceId: string): Promise<AlertSettings> {
  const [row] = await db
    .select({
      timezone: workspace.timezone,
      quietHoursStart: workspace.quietHoursStart,
      quietHoursEnd: workspace.quietHoursEnd,
      severity5BypassesQuietHours: workspace.severity5BypassesQuietHours,
      alertsPerHour: workspace.alertsPerHour,
      burstWindowSeconds: workspace.burstWindowSeconds,
    })
    .from(workspace)
    .where(eq(workspace.id, workspaceId));
  if (row === undefined) throw new Error(`No Workspace ${workspaceId}`);
  return row;
}

/** Saves all of the form, or none of it when a field is wrong. */
export async function saveAlertSettings(db: Db, workspaceId: string, form: AlertSettingsForm) {
  const parsed = parseAlertSettings(form);
  if ("errors" in parsed) return parsed;
  await db.update(workspace).set(parsed.values).where(eq(workspace.id, workspaceId));
  return { saved: true as const };
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

const formFields = ["timezone", "quietHoursStart", "quietHoursEnd", "alertsPerHour", "burstWindowSeconds"] as const;

/** The form from what it posted, or from the query a refused save sends it back with. */
export function readAlertSettingsForm(get: (name: string) => unknown): AlertSettingsForm {
  const text = (name: string) => {
    const value = get(name);
    return typeof value === "string" ? value : "";
  };
  return {
    timezone: text("timezone"),
    quietHoursStart: text("quietHoursStart"),
    quietHoursEnd: text("quietHoursEnd"),
    alertsPerHour: text("alertsPerHour"),
    burstWindowSeconds: text("burstWindowSeconds"),
    quietHours: text("quietHours") === "on",
    severity5Bypasses: text("severity5Bypasses") === "on",
  };
}

/** The query that brings a refused form back as it was posted. */
export function alertSettingsQuery(form: AlertSettingsForm) {
  return new URLSearchParams({
    refused: "1",
    ...Object.fromEntries(formFields.map((name) => [name, form[name]])),
    ...(form.quietHours ? { quietHours: "on" } : {}),
    ...(form.severity5Bypasses ? { severity5Bypasses: "on" } : {}),
  }).toString();
}

/**
 * The Destinations the Health alerts setting can name: the Workspace's confirmed Telegram chats and email
 * addresses (docs: Actions and delivery, "Source Health alerts"). `named` says the setting names it now.
 * One named before it lost its confirmation is listed too, so it can be unticked.
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
        or(isNotNull(destination.confirmedAt), isNotNull(healthAlertDestination.destinationId)),
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
    await tx.delete(healthAlertDestination).where(eq(healthAlertDestination.workspaceId, workspaceId));
    if (ids.length === 0) return;
    const allowed = await tx
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
      // Shared, so a remove of the Destination waits rather than fail this insert's foreign key.
      .for("key share");
    if (allowed.length === 0) return;
    await tx.insert(healthAlertDestination).values(allowed.map(({ destinationId }) => ({ workspaceId, destinationId })));
  });
}
