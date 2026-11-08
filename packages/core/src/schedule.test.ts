import { describe, expect, it } from "vitest";
import { defaultSchedule, nextFiring, nextPollAt, scheduleError } from "./schedule.ts";

const at = (time: string) => new Date(`2026-11-03T${time}Z`);

describe("scheduleError", () => {
  it("accepts the default of every 15 minutes in both modes", () => {
    expect(defaultSchedule).toBe("*/15 * * * *");
    expect(scheduleError(defaultSchedule, "hosted")).toBeUndefined();
    expect(scheduleError(defaultSchedule, "self-hosted")).toBeUndefined();
  });

  it("refuses a schedule more often than every 15 minutes on hosted, naming the minimum", () => {
    expect(scheduleError("*/5 * * * *", "hosted")).toBe(
      "A schedule can't run more often than every 15 minutes on hosted.",
    );
  });

  it("allows every 5 minutes on self-hosted, and refuses anything more often", () => {
    expect(scheduleError("*/5 * * * *", "self-hosted")).toBeUndefined();
    expect(scheduleError("*/2 * * * *", "self-hosted")).toBe(
      "A schedule can't run more often than every 5 minutes on self-hosted.",
    );
  });

  it("refuses a schedule that is mostly slow but has one short gap", () => {
    expect(scheduleError("0,5 * * * *", "hosted")).toMatch(/15 minutes/);
    // 23:55 and the next day's 00:00 are 5 minutes apart.
    expect(scheduleError("0,55 0,23 * * *", "hosted")).toMatch(/15 minutes/);
    // Only Mondays, but every minute of them.
    expect(scheduleError("* * * * 1", "self-hosted")).toMatch(/5 minutes/);
  });

  it("refuses a seconds field that fires more often than the minimum", () => {
    expect(scheduleError("*/30 * * * * *", "self-hosted")).toMatch(/5 minutes/);
  });

  it("asks only for a cron expression when it isn't told the mode", () => {
    expect(scheduleError("* * * * *")).toBeUndefined();
    expect(scheduleError("weekly")).toBe('"weekly" isn\'t a cron expression.');
    expect(scheduleError("0 0 31 2 *")).toBe('"0 0 31 2 *" isn\'t a cron expression.');
  });

  it("refuses text too long to be a schedule, without repeating it", () => {
    const schedule = `0 * * * ${"1,".repeat(200)}2`;
    expect(scheduleError(schedule, "hosted")).toBe("A schedule can be at most 200 characters.");
  });

  it("gives the same answer for a schedule after many others have been checked", () => {
    for (let i = 0; i < 1100; i++) scheduleError(`not cron ${String(i)}`, "hosted");
    expect(scheduleError("not cron 0", "hosted")).toBe('"not cron 0" isn\'t a cron expression.');
    expect(scheduleError(defaultSchedule, "hosted")).toBeUndefined();
  });

  it("accepts slower schedules and aliases", () => {
    for (const schedule of ["0 * * * *", "@hourly", " @hourly ", "30 9 * * 1-5", "0 0 29 2 *"]) {
      expect(scheduleError(schedule, "hosted")).toBeUndefined();
    }
  });

  it("finds a short gap that only a leap day has", () => {
    // 23:55 on 28 February and 00:00 on 29 February.
    expect(scheduleError("0,55 0,23 28,29 2 *", "hosted")).toMatch(/15 minutes/);
  });

  it("refuses an expression that isn't cron", () => {
    for (const schedule of ["", "every 15 minutes", "61 * * * *", "* * * *"]) {
      expect(scheduleError(schedule, "self-hosted")).toBe(`"${schedule}" isn't a cron expression.`);
    }
  });
});

describe("nextPollAt", () => {
  it("is the schedule's next time after now, in UTC", () => {
    expect(nextPollAt("*/15 * * * *", "hosted", at("15:07:00"), () => 0)).toEqual(at("15:15:00"));
    expect(nextPollAt("*/15 * * * *", "hosted", at("15:15:00"), () => 0)).toEqual(at("15:30:00"));
    expect(nextPollAt("30 9 * * *", "hosted", at("15:07:00"), () => 0)).toEqual(
      new Date("2026-11-04T09:30:00Z"),
    );
  });

  it("adds jitter of up to 10% of the interval", () => {
    // 10% of 5 minutes is 30 s.
    expect(nextPollAt("*/5 * * * *", "self-hosted", at("15:07:00"), () => 0.5)).toEqual(
      at("15:10:15"),
    );
    expect(nextPollAt("*/5 * * * *", "self-hosted", at("15:07:00"), () => 0.999)).toEqual(
      at("15:10:29.970"),
    );
  });

  it("caps the jitter at 60 s", () => {
    // 10% of 15 minutes would be 90 s.
    expect(nextPollAt("*/15 * * * *", "hosted", at("15:07:00"), () => 0.999)).toEqual(
      at("15:15:59.940"),
    );
  });

  it("falls back to the default schedule when the mode refuses the Source's", () => {
    expect(nextPollAt("*/5 * * * *", "hosted", at("15:07:00"), () => 0)).toEqual(at("15:15:00"));
    expect(nextPollAt(" @hourly ", "hosted", at("15:07:00"), () => 0)).toEqual(at("16:00:00"));
    expect(nextPollAt("not cron", "self-hosted", at("15:07:00"), () => 0)).toEqual(at("15:15:00"));
  });
});

describe("nextFiring", () => {
  it("reads the schedule in the timezone: 08:00 in Moscow is 05:00 UTC", () => {
    expect(nextFiring("0 8 * * *", new Date("2026-11-03T04:00:00Z"), "Europe/Moscow")).toEqual(
      new Date("2026-11-03T05:00:00Z"),
    );
    expect(nextFiring("0 8 * * *", new Date("2026-11-03T05:00:00Z"), "Europe/Moscow")).toEqual(
      new Date("2026-11-04T05:00:00Z"),
    );
  });

  it("is the schedule in UTC without a timezone", () => {
    expect(nextFiring("*/15 * * * *", at("10:07:00"))).toEqual(at("10:15:00"));
  });

  it("moves a time in a daylight saving gap forward rather than skipping the day", () => {
    // Havana's midnight on 8 March 2026 doesn't exist: 00:00 CST becomes 01:00 CDT, at 05:00 UTC.
    expect(nextFiring("0 0 * * *", new Date("2026-03-07T12:00:00Z"), "America/Havana")).toEqual(
      new Date("2026-03-08T05:00:00Z"),
    );
    // The day after is an ordinary midnight in CDT, UTC-4.
    expect(nextFiring("0 0 * * *", new Date("2026-03-08T05:00:00Z"), "America/Havana")).toEqual(
      new Date("2026-03-09T04:00:00Z"),
    );
  });

  it("fires once on a time the clocks go back through", () => {
    // Berlin's 02:30 on 25 October 2026 happens twice: at 00:30 and 01:30 UTC.
    const first = nextFiring("30 2 * * *", new Date("2026-10-24T12:00:00Z"), "Europe/Berlin");
    expect(first).toEqual(new Date("2026-10-25T00:30:00Z"));
    expect(nextFiring("30 2 * * *", first, "Europe/Berlin")).toEqual(new Date("2026-10-26T01:30:00Z"));
  });
});
