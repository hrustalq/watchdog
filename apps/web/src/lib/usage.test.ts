import { describe, expect, it } from "vitest";
import { formatCost, isFloor, monthLabel, parseMonth, shiftMonth, type UsageTally } from "./usage.ts";

describe("the month in the URL", () => {
  const now = new Date("2026-11-05T12:00:00.000Z");

  it("is taken when it's a past month or this one", () => {
    expect(parseMonth("2026-10", now)).toBe("2026-10");
    expect(parseMonth("2026-11", now)).toBe("2026-11");
  });

  it("falls back to this month otherwise", () => {
    for (const value of [undefined, "", "2026-13", "2026-00", "2026-1", "0000-01", "nonsense", "2026-12", ["2026-10"]]) {
      expect(parseMonth(value, now)).toBe("2026-11");
    }
  });

  it("uses this month in UTC, whatever the time zone", () => {
    expect(parseMonth(undefined, new Date("2026-11-01T01:00:00.000+03:00"))).toBe("2026-10");
  });
});

describe("moving between months", () => {
  it("crosses a year in both directions", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2027-01", -1)).toBe("2026-12");
  });

  it("names a month as the UTC calendar does, wherever the server is", () => {
    expect(monthLabel("2026-10")).toBe("October 2026");
  });
});

describe("an estimated cost", () => {
  it("shows four decimals, and never rounds a small cost down to nothing", () => {
    expect(formatCost(3.5)).toBe("3.5000");
    expect(formatCost(1234.5)).toBe("1,234.5000");
    expect(formatCost(0)).toBe("0.0000");
    expect(formatCost(0.000_003)).toBe("<0.0001");
  });
});

describe("whether a cost is only a floor", () => {
  const tally: UsageTally = {
    calls: 3,
    failed: 0,
    inputTokens: 10,
    outputTokens: 1,
    withoutTokens: 0,
    unpricedCalls: 0,
    cost: 1,
  };

  it("isn't when every call is in it", () => {
    expect(isFloor(tally)).toBe(false);
  });

  it("is when a call had no prices, or came back with no token counts", () => {
    expect(isFloor({ ...tally, unpricedCalls: 1 })).toBe(true);
    expect(isFloor({ ...tally, withoutTokens: 1 })).toBe(true);
  });
});
