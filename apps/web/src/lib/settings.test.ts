import { describe, expect, it } from "vitest";
import {
  type AlertSettings,
  type AlertSettingsForm,
  type DeliverySettingsForm,
  deliveryRefusalQuery,
  parseAlertSettings,
  quietHoursSentence,
  readDeliverySettingsForm,
  readRetentionSettingsForm,
  type RetentionSettingsForm,
  resolveSettingsTab,
  retentionRefusalQuery,
  settingsFormValues,
  settingsTabs,
  settingsTabsFor,
  settingsTabHref,
  timezones,
} from "./settings.ts";

const form = (values: Partial<AlertSettingsForm> = {}): AlertSettingsForm => ({
  timezone: "Europe/Moscow",
  quietHours: true,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  severity5Bypasses: false,
  alertsPerHour: "20",
  burstWindowSeconds: "60",
  itemsRetentionDays: "90",
  itemsUnlimited: false,
  logRetentionDays: "30",
  logUnlimited: false,
  ...values,
});

/** The fields a form was refused on, or "saved". */
function refusedOn(posted: AlertSettingsForm) {
  const result = parseAlertSettings(posted);
  return "errors" in result ? Object.keys(result.errors).sort() : "saved";
}

describe("parseAlertSettings", () => {
  it("reads a valid form as the Workspace's columns", () => {
    expect(parseAlertSettings(form({ severity5Bypasses: true }))).toEqual({
      values: {
        timezone: "Europe/Moscow",
        quietHoursStart: "22:00",
        quietHoursEnd: "07:00",
        severity5BypassesQuietHours: true,
        alertsPerHour: 20,
        burstWindowSeconds: 60,
        itemsRetentionDays: 90,
        logRetentionDays: 30,
      },
    });
  });

  it("clears both times when quiet hours are off, whatever the fields hold", () => {
    expect(parseAlertSettings(form({ quietHours: false, quietHoursStart: "25:00", quietHoursEnd: "" }))).toMatchObject({
      values: { quietHoursStart: null, quietHoursEnd: null },
    });
  });

  it.each(["UTC", "Europe/Moscow", "America/Argentina/Buenos_Aires", "Asia/Kolkata"])("accepts the timezone %s", (timezone) => {
    expect(parseAlertSettings(form({ timezone }))).toHaveProperty("values");
  });

  it.each([
    ["utc", "UTC"],
    [" Europe/Moscow\n", "Europe/Moscow"],
    ["Europe/Kyiv", new Intl.DateTimeFormat("en", { timeZone: "Europe/Kyiv" }).resolvedOptions().timeZone],
  ])("saves the timezone %s by its listed name", (timezone, listed) => {
    expect(timezones).toContain(listed);
    expect(parseAlertSettings(form({ timezone }))).toMatchObject({ values: { timezone: listed } });
  });

  it.each(["Mars/Olympus", "", " ", "+03:00"])("refuses the timezone %j beside its field", (timezone) => {
    expect(refusedOn(form({ timezone }))).toEqual(["timezone"]);
  });

  it.each(["25:00", "7:00", "07:60", "07:00:00", "", "noon"])("refuses the start time %j beside its field", (start) => {
    expect(refusedOn(form({ quietHoursStart: start }))).toEqual(["quietHoursStart"]);
  });

  it("refuses an end time equal to the start, which would be no window at all", () => {
    expect(refusedOn(form({ quietHoursEnd: "22:00" }))).toEqual(["quietHoursEnd"]);
  });

  it.each([
    ["alertsPerHour", "0"],
    ["alertsPerHour", "1001"],
    ["alertsPerHour", "2.5"],
    ["alertsPerHour", ""],
    ["alertsPerHour", "1e3"],
    ["burstWindowSeconds", "-1"],
    ["burstWindowSeconds", "601"],
    ["burstWindowSeconds", " 60"],
  ] as const)("refuses %s of %j beside its field", (name, value) => {
    expect(refusedOn(form({ [name]: value }))).toEqual([name]);
  });

  it.each([
    ["alertsPerHour", "1", 1],
    ["alertsPerHour", "1000", 1000],
    ["burstWindowSeconds", "0", 0],
    ["burstWindowSeconds", "600", 600],
  ] as const)("accepts %s at the edge %j", (name, value, parsed) => {
    expect(parseAlertSettings(form({ [name]: value }))).toMatchObject({ values: { [name]: parsed } });
  });

  it.each([
    ["itemsRetentionDays", "1"],
    ["itemsRetentionDays", "3650"],
    ["logRetentionDays", "7"],
  ] as const)("accepts %s of %j days", (name, value) => {
    expect(parseAlertSettings(form({ [name]: value }))).toMatchObject({ values: { [name]: Number(value) } });
  });

  it.each([
    ["itemsRetentionDays", "0"],
    ["itemsRetentionDays", "3651"],
    ["itemsRetentionDays", ""],
    ["logRetentionDays", "1.5"],
    ["logRetentionDays", "-30"],
  ] as const)("refuses %s of %j beside its field", (name, value) => {
    expect(refusedOn(form({ [name]: value }))).toEqual([name]);
  });

  it("reads a ticked Unlimited as no window at all on a self-hosted install", () => {
    expect(parseAlertSettings(form({ itemsUnlimited: true, logUnlimited: true }), { selfHosted: true })).toMatchObject({
      values: { itemsRetentionDays: null, logRetentionDays: null },
    });
  });

  it("ignores the day count a ticked Unlimited leaves behind", () => {
    expect(
      parseAlertSettings(form({ itemsUnlimited: true, itemsRetentionDays: "", logRetentionDays: "60" }), {
        selfHosted: true,
      }),
    ).toMatchObject({ values: { itemsRetentionDays: null, logRetentionDays: 60 } });
  });

  it.each([
    ["itemsUnlimited", "itemsRetentionDays"],
    ["logUnlimited", "logRetentionDays"],
  ] as const)("refuses %s on hosted, which keeps the defaults as its free limits", (name, field) => {
    expect(refusedOn(form({ [name]: true }))).toEqual([field]);
  });

  it("reports every field that's wrong at once", () => {
    expect(refusedOn(form({ timezone: "Mars/Olympus", quietHoursStart: "25:00", alertsPerHour: "0" }))).toEqual([
      "alertsPerHour",
      "quietHoursStart",
      "timezone",
    ]);
  });
});

describe("quietHoursSentence", () => {
  it("says when alerts are held, in the Workspace timezone", () => {
    expect(
      quietHoursSentence({
        timezone: "Europe/Moscow",
        quietHoursStart: "22:00:00",
        quietHoursEnd: "07:00:00",
        severity5BypassesQuietHours: false,
      }),
    ).toBe("Alerts are held from 22:00 to 07:00 Europe/Moscow.");
  });

  it("says that Severity 5 still goes when it bypasses them", () => {
    expect(
      quietHoursSentence({
        timezone: "UTC",
        quietHoursStart: "13:30:00",
        quietHoursEnd: "14:00:00",
        severity5BypassesQuietHours: true,
      }),
    ).toBe("Alerts are held from 13:30 to 14:00 UTC. Severity 5 alerts still go at once.");
  });

  it("says nothing is held when they're off", () => {
    expect(
      quietHoursSentence({ timezone: "UTC", quietHoursStart: null, quietHoursEnd: null, severity5BypassesQuietHours: true }),
    ).toBe("Alerts go as soon as they're due, at any hour.");
  });
});

describe("timezones", () => {
  it("lists UTC first, then the IANA zones", () => {
    expect(timezones[0]).toBe("UTC");
    expect(timezones).toContain("Europe/Moscow");
    expect(new Set(timezones).size).toBe(timezones.length);
  });
});

describe("a refused tab's round trip", () => {
  /** The Delivery tab's fields, taken from a full form so the tests say which fields it owns. */
  const deliveryOf = (values: Partial<AlertSettingsForm> = {}): DeliverySettingsForm => {
    const { timezone, quietHours, quietHoursStart, quietHoursEnd, severity5Bypasses, alertsPerHour, burstWindowSeconds } =
      form(values);
    return { timezone, quietHours, quietHoursStart, quietHoursEnd, severity5Bypasses, alertsPerHour, burstWindowSeconds };
  };
  /** The Retention tab's fields, the same way: a change here must not carry the other tab's. */
  const retentionOf = (values: Partial<AlertSettingsForm> = {}): RetentionSettingsForm => {
    const { itemsRetentionDays, itemsUnlimited, logRetentionDays, logUnlimited } = form(values);
    return { itemsRetentionDays, itemsUnlimited, logRetentionDays, logUnlimited };
  };

  it.each([
    deliveryOf(),
    deliveryOf({ quietHours: false, severity5Bypasses: true, timezone: "Mars/Olympus", quietHoursStart: "25:00" }),
  ])("brings a refused Delivery form back as it was posted, on its own tab", (posted) => {
    const query = new URLSearchParams(deliveryRefusalQuery(posted));

    expect(query.get("refused")).toBe("1");
    expect(query.get("tab")).toBe("delivery");
    expect(readDeliverySettingsForm((name) => query.get(name) ?? undefined)).toEqual(posted);
  });

  it.each([retentionOf(), retentionOf({ itemsRetentionDays: "", itemsUnlimited: true })])(
    "brings a refused Retention form back as it was posted, on its own tab",
    (posted) => {
      const query = new URLSearchParams(retentionRefusalQuery(posted));

      expect(query.get("refused")).toBe("1");
      expect(query.get("tab")).toBe("retention");
      expect(readRetentionSettingsForm((name) => query.get(name) ?? undefined)).toEqual(posted);
    },
  );

  it("carries only the refused tab's fields, so a link can't reset the other tab's", () => {
    const query = new URLSearchParams(deliveryRefusalQuery(deliveryOf({ timezone: "Mars/Olympus" })));

    expect([...query.keys()].sort()).toEqual([
      "alertsPerHour",
      "burstWindowSeconds",
      "quietHours",
      "quietHoursEnd",
      "quietHoursStart",
      "refused",
      "tab",
      "timezone",
    ]);
    expect([...new URLSearchParams(retentionRefusalQuery(retentionOf())).keys()].sort()).toEqual([
      "itemsRetentionDays",
      "logRetentionDays",
      "refused",
      "tab",
    ]);
  });

  it("reads a missing or repeated field as empty", () => {
    expect(readDeliverySettingsForm((name) => (name === "timezone" ? ["UTC", "UTC"] : undefined))).toMatchObject({
      timezone: "",
      quietHours: false,
    });
  });
});

describe("settingsFormValues", () => {
  const saved = (values: Partial<AlertSettings> = {}): AlertSettings => ({
    timezone: "Europe/Moscow",
    quietHoursStart: null,
    quietHoursEnd: null,
    severity5BypassesQuietHours: false,
    alertsPerHour: 20,
    burstWindowSeconds: 60,
    itemsRetentionDays: 90,
    logRetentionDays: 30,
    ...values,
  });

  it("shows what's saved, with the times to the minute and the numbers as the fields post them", () => {
    expect(settingsFormValues(saved({ quietHoursStart: "22:00:00", quietHoursEnd: "07:00:00" }))).toEqual({
      timezone: "Europe/Moscow",
      quietHours: true,
      quietHoursStart: "22:00",
      quietHoursEnd: "07:00",
      severity5Bypasses: false,
      alertsPerHour: "20",
      burstWindowSeconds: "60",
      itemsRetentionDays: "90",
      itemsUnlimited: false,
      logRetentionDays: "30",
      logUnlimited: false,
    });
  });

  it("keeps a window field showing what a window would start from while it is unlimited", () => {
    expect(settingsFormValues(saved({ itemsRetentionDays: null, logRetentionDays: null }))).toMatchObject({
      itemsRetentionDays: "90",
      itemsUnlimited: true,
      logRetentionDays: "30",
      logUnlimited: true,
    });
  });

  it("starts quiet hours' times at 22:00 to 07:00 while they're off, so turning them on is one tick", () => {
    expect(settingsFormValues(saved())).toMatchObject({ quietHours: false, quietHoursStart: "22:00", quietHoursEnd: "07:00" });
  });
});

describe("the Settings screen's tabs", () => {
  it("puts Delivery first, so /settings and an unknown tab land on it", () => {
    expect(settingsTabs.map((tab) => tab.value)).toEqual(["delivery", "retention", "health", "workspace", "instance"]);
    expect(resolveSettingsTab(undefined, { admin: false })).toBe("delivery");
    expect(resolveSettingsTab("deliveries", { admin: false })).toBe("delivery");
    expect(resolveSettingsTab(["retention", "delivery"], { admin: false })).toBe("delivery");
    expect(resolveSettingsTab("retention", { admin: false })).toBe("retention");
  });

  it("keeps Instance for an admin, and sends a link to it back to Delivery for everyone else", () => {
    expect(settingsTabsFor(false).map((tab) => tab.value)).toEqual(["delivery", "retention", "health", "workspace"]);
    expect(settingsTabsFor(true).map((tab) => tab.value)).toEqual([
      "delivery",
      "retention",
      "health",
      "workspace",
      "instance",
    ]);
    expect(resolveSettingsTab("instance", { admin: false })).toBe("delivery");
    expect(resolveSettingsTab("instance", { admin: true })).toBe("instance");
  });

  it("names each tab, and links it with its own URL", () => {
    expect(settingsTabs.map((tab) => tab.label)).toEqual(["Delivery", "Retention", "Health alerts", "Workspace", "Instance"]);
    expect(settingsTabHref("retention")).toBe("/settings?tab=retention");
  });
});
