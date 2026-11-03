import { describe, expect, it } from "vitest";
import { parseCursor } from "./feed.ts";

const id = "0b6f2a4e-8c1d-4f3a-9e2b-7d5c6a1f0e9d";

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
