import { describe, expect, it } from "vitest";
import {
  type AlertSettingsForm,
  alertSettingsQuery,
  parseAlertSettings,
  quietHoursSentence,
  readAlertSettingsForm,
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
    ["Europe/Kyiv", new Intl.DateTimeFormat("en", { timeZone: "Europe/Kyiv" }).resolvedOptions().timeZone],
  ])("saves the timezone %s by its listed name", (timezone, listed) => {
    expect(timezones).toContain(listed);
    expect(parseAlertSettings(form({ timezone }))).toMatchObject({ values: { timezone: listed } });
  });

  it.each(["Mars/Olympus", "", "+03:00", "Europe/Moscow "])("refuses the timezone %j beside its field", (timezone) => {
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

describe("a refused form's round trip", () => {
  it.each([
    form(),
    form({ quietHours: false, severity5Bypasses: true, timezone: "Mars/Olympus", quietHoursStart: "25:00" }),
  ])("comes back from the query as it was posted", (posted) => {
    const query = new URLSearchParams(alertSettingsQuery(posted));

    expect(query.get("refused")).toBe("1");
    expect(readAlertSettingsForm((name) => query.get(name) ?? undefined)).toEqual(posted);
  });

  it("reads a missing or repeated field as empty", () => {
    expect(readAlertSettingsForm((name) => (name === "timezone" ? ["UTC", "UTC"] : undefined))).toMatchObject({
      timezone: "",
      quietHours: false,
    });
  });
});
