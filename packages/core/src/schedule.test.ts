import { describe, expect, it } from "vitest";
import { defaultSchedule, nextPollAt, scheduleError } from "./schedule.ts";

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

  it("accepts slower schedules and aliases", () => {
    for (const schedule of ["0 * * * *", "@hourly", "30 9 * * 1-5", "0 0 29 2 *"]) {
      expect(scheduleError(schedule, "hosted")).toBeUndefined();
    }
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
    expect(nextPollAt("not cron", "self-hosted", at("15:07:00"), () => 0)).toEqual(at("15:15:00"));
  });
});
