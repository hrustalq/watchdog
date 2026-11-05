import { describe, expect, it } from "vitest";
import { manualRunIn, parseCursor } from "./feed.ts";

const id = "0b6f2a4e-8c1d-4f3a-9e2b-7d5c6a1f0e9d";

describe("manualRunIn", () => {
  const captured = { id: 1, message: "Captured from Blog", data: {} };
  const worked = { id: 2, message: "Manual run: extracted cve", data: { manual: true } };
  const failed = { id: 3, message: "Manual run: failed", data: { manual: true, failed: true } };
  const later = { id: 4, message: "Rated", data: {} };

  it("finds the run the URL names and whether it failed", () => {
    expect(manualRunIn([captured, worked, later], "2")).toEqual({
      id: 2,
      message: "Manual run: extracted cve",
      failed: false,
    });
    expect(manualRunIn([captured, failed], "3")).toEqual({ id: 3, message: "Manual run: failed", failed: true });
  });

  it("ignores a run a newer one replaced, so a success can't sit above a later failure", () => {
    expect(manualRunIn([captured, worked, failed], "2")).toBeUndefined();
  });

  it("ignores a row that isn't a manual run, one not in this Log, and anything else", () => {
    const log = [captured, worked, later];
    expect(manualRunIn(log, "1")).toBeUndefined();
    expect(manualRunIn(log, "4")).toBeUndefined();
    expect(manualRunIn(log, "9")).toBeUndefined();
    expect(manualRunIn(log, ["2"])).toBeUndefined();
    expect(manualRunIn(log, undefined)).toBeUndefined();
  });
});

describe("parseCursor", () => {
  it("reads the sort keys of an Item with and without a published time", () => {
    expect(parseCursor(`2026-11-03T15:00:00.123456Z_2026-11-01T08:30:00.000000Z_${id}`)).toEqual({
      captured: "2026-11-03T15:00:00.123456Z",
      published: "2026-11-01T08:30:00.000000Z",
      id,
    });
    expect(parseCursor(`2026-11-03T15:00:00.123456Z_-infinity_${id}`)).toEqual({
      captured: "2026-11-03T15:00:00.123456Z",
      published: "-infinity",
      id,
    });
  });

  it.each([
    ["no cursor", undefined],
    ["a repeated parameter", ["a", "b"]],
    ["a bare Item id", id],
    ["a day that doesn't exist", `2026-02-30T00:00:00.000000Z_-infinity_${id}`],
    ["a month that doesn't exist", `2026-13-01T00:00:00.000000Z_-infinity_${id}`],
    ["year 0, which Postgres refuses", `0000-01-01T00:00:00.000000Z_-infinity_${id}`],
    ["a time without microseconds", `2026-11-03T15:00:00Z_-infinity_${id}`],
    ["a captured time of -infinity", `-infinity_-infinity_${id}`],
    ["an id that isn't a uuid", "2026-11-03T15:00:00.123456Z_-infinity_x"],
    ["an extra part", `2026-11-03T15:00:00.123456Z_-infinity_${id}_x`],
    ["SQL", `2026-11-03T15:00:00.123456Z_'); drop table item; --_${id}`],
  ])("rejects %s", (_, value) => {
    expect(parseCursor(value)).toBeUndefined();
  });
});
