import { describe, expect, it } from "vitest";
import { type AlertSettings, scheduleDelivery } from "./schedule-delivery.ts";

const settings: AlertSettings = {
  timezone: "UTC",
  quietHoursStart: null,
  quietHoursEnd: null,
  severity5BypassesQuietHours: false,
  alertsPerHour: 20,
  burstWindowSeconds: 60,
};
const overnight = { ...settings, quietHoursStart: "22:00:00", quietHoursEnd: "07:00:00" };
const at = (time: string) => new Date(`2026-01-07T${time}Z`);

describe("scheduleDelivery", () => {
  it("sends a lone alert at once when nothing holds it", () => {
    expect(scheduleDelivery({ settings, now: at("12:00:00"), severity: 3, recentSends: [] })).toEqual({ kind: "send" });
  });

  describe("quiet hours", () => {
    it("holds an alert inside them until they end", () => {
      const quiet = { ...settings, quietHoursStart: "09:00:00", quietHoursEnd: "17:30:00" };
      expect(scheduleDelivery({ settings: quiet, now: at("12:00:00"), severity: 4, recentSends: [] })).toEqual({
        kind: "hold",
        reason: "quiet hours",
        until: at("17:30:00"),
      });
    });

    it("sends outside them, with the end itself outside and the start inside", () => {
      const quiet = { ...settings, quietHoursStart: "09:00:00", quietHoursEnd: "17:30:00" };
      const decide = (now: Date) => scheduleDelivery({ settings: quiet, now, severity: 4, recentSends: [] }).kind;
      expect(decide(at("08:59:59"))).toBe("send");
      expect(decide(at("09:00:00"))).toBe("hold");
      expect(decide(at("17:29:59"))).toBe("hold");
      expect(decide(at("17:30:00"))).toBe("send");
    });

    it("works across midnight, before and after it", () => {
      const decide = (now: Date) => scheduleDelivery({ settings: overnight, now, severity: 4, recentSends: [] });
      expect(decide(at("23:00:00"))).toEqual({
        kind: "hold",
        reason: "quiet hours",
        until: new Date("2026-01-08T07:00:00Z"),
      });
      expect(decide(at("03:00:00"))).toEqual({ kind: "hold", reason: "quiet hours", until: at("07:00:00") });
      expect(decide(at("12:00:00"))).toEqual({ kind: "send" });
    });

    it("reads them in the Workspace timezone", () => {
      const berlin = { ...overnight, timezone: "Europe/Berlin" };
      // 21:30 UTC is 22:30 in Berlin in January, and 07:00 there is 06:00 UTC.
      expect(scheduleDelivery({ settings: berlin, now: at("21:30:00"), severity: 4, recentSends: [] })).toEqual({
        kind: "hold",
        reason: "quiet hours",
        until: new Date("2026-01-08T06:00:00Z"),
      });
      expect(scheduleDelivery({ settings: overnight, now: at("21:30:00"), severity: 4, recentSends: [] }).kind).toBe(
        "send",
      );
    });

    it("holds across a daylight saving change, ending at the local time on the day", () => {
      const berlin = { ...overnight, timezone: "Europe/Berlin" };
      // Clocks in Berlin go forward on 29 March 2026, so 07:00 that morning is 05:00 UTC.
      const now = new Date("2026-03-28T22:00:00Z");
      expect(scheduleDelivery({ settings: berlin, now, severity: 4, recentSends: [] })).toEqual({
        kind: "hold",
        reason: "quiet hours",
        until: new Date("2026-03-29T05:00:00Z"),
      });
    });

    it("ends at the first moment after an end time the clocks skipped, not the next day", () => {
      const havana = { ...settings, timezone: "America/Havana", quietHoursStart: "22:00:00", quietHoursEnd: "00:00:00" };
      // Clocks in Havana go from 00:00 to 01:00 on 8 March 2026, so 00:00 that day never happens.
      // 04:00 UTC is 23:00 on the 7th there, and quiet hours end an hour later, at 01:00 local.
      const now = new Date("2026-03-08T04:00:00Z");
      expect(scheduleDelivery({ settings: havana, now, severity: 4, recentSends: [] })).toEqual({
        kind: "hold",
        reason: "quiet hours",
        until: new Date("2026-03-08T05:00:00Z"),
      });
    });

    it("ends inside the gap on a European change day", () => {
      const berlin = { ...settings, timezone: "Europe/Berlin", quietHoursStart: "01:00:00", quietHoursEnd: "02:30:00" };
      // Clocks in Berlin go from 02:00 to 03:00 on 29 March 2026, so 02:30 that day never happens.
      const now = new Date("2026-03-29T00:30:00Z");
      expect(scheduleDelivery({ settings: berlin, now, severity: 4, recentSends: [] })).toEqual({
        kind: "hold",
        reason: "quiet hours",
        until: new Date("2026-03-29T01:00:00Z"),
      });
    });

    it("ends at the first reading of an end time the clocks repeat", () => {
      const berlin = { ...settings, timezone: "Europe/Berlin", quietHoursStart: "22:00:00", quietHoursEnd: "02:30:00" };
      // Clocks in Berlin go from 03:00 to 02:00 on 25 October 2026, so 02:30 happens twice, an hour apart.
      const hold = (now: string) =>
        scheduleDelivery({ settings: berlin, now: new Date(now), severity: 4, recentSends: [] });
      expect(hold("2026-10-24T21:00:00Z")).toEqual({
        kind: "hold",
        reason: "quiet hours",
        until: new Date("2026-10-25T00:30:00Z"),
      });
      // Past the first reading of it, the second one ends them.
      expect(hold("2026-10-25T01:10:00Z")).toEqual({
        kind: "hold",
        reason: "quiet hours",
        until: new Date("2026-10-25T01:30:00Z"),
      });
    });

    it("lets Severity 5 through only with the bypass on", () => {
      const bypass = { ...overnight, severity5BypassesQuietHours: true };
      const now = at("23:00:00");
      expect(scheduleDelivery({ settings: bypass, now, severity: 5, recentSends: [] }).kind).toBe("send");
      expect(scheduleDelivery({ settings: bypass, now, severity: 4, recentSends: [] }).kind).toBe("hold");
      expect(scheduleDelivery({ settings: bypass, now, severity: null, recentSends: [] }).kind).toBe("hold");
      expect(scheduleDelivery({ settings: overnight, now, severity: 5, recentSends: [] }).kind).toBe("hold");
    });

    it("treats a window that starts and ends at the same time as empty", () => {
      const empty = { ...settings, quietHoursStart: "07:00:00", quietHoursEnd: "07:00:00" };
      expect(scheduleDelivery({ settings: empty, now: at("07:00:00"), severity: 4, recentSends: [] }).kind).toBe("send");
    });
  });

  describe("the rate limit", () => {
    const sends = (count: number) => Array.from({ length: count }, (_, minute) => at(`11:${String(minute + 10)}:00`));

    it("sends the 20th alert of an hour", () => {
      const decision = scheduleDelivery({ settings, now: at("12:00:00"), severity: 4, recentSends: sends(19) });
      expect(decision.kind).toBe("send");
    });

    it("holds the 21st until the oldest leaves the hour", () => {
      expect(scheduleDelivery({ settings, now: at("12:00:00"), severity: 4, recentSends: sends(20) })).toEqual({
        kind: "hold",
        reason: "rate limit",
        until: at("12:10:00"),
      });
    });

    it("waits for enough to leave after the limit was lowered", () => {
      const lowered = { ...settings, alertsPerHour: 18 };
      expect(scheduleDelivery({ settings: lowered, now: at("12:00:00"), severity: 4, recentSends: sends(20) })).toEqual({
        kind: "hold",
        reason: "rate limit",
        until: at("12:12:00"),
      });
    });
  });

  describe("the burst window", () => {
    it("groups an alert until the window after the last send closes", () => {
      expect(
        scheduleDelivery({ settings, now: at("12:00:30"), severity: 4, recentSends: [at("12:00:00")] }),
      ).toEqual({ kind: "group", until: at("12:01:00") });
    });

    it("sends once the window has closed", () => {
      const decide = (now: Date) => scheduleDelivery({ settings, now, severity: 4, recentSends: [at("12:00:00")] });
      expect(decide(at("12:01:00")).kind).toBe("send");
    });

    it("never groups with a window of zero", () => {
      const off = { ...settings, burstWindowSeconds: 0 };
      const now = at("12:00:00");
      expect(scheduleDelivery({ settings: off, now, severity: 4, recentSends: [now] }).kind).toBe("send");
    });
  });

  it("checks quiet hours before the rate limit, and the rate limit before the burst window", () => {
    const now = at("23:00:30");
    const recentSends = Array.from({ length: 20 }, () => at("23:00:00"));
    expect(scheduleDelivery({ settings: overnight, now, severity: 4, recentSends })).toMatchObject({
      reason: "quiet hours",
    });
    expect(scheduleDelivery({ settings, now, severity: 4, recentSends })).toMatchObject({ reason: "rate limit" });
  });
});
