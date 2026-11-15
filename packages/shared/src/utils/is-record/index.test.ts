import { describe, expect, it } from "vitest";
import { isRecord } from "./index.ts";

describe("isRecord", () => {
  it("takes an object and an array", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(true);
  });

  it("refuses null and every primitive", () => {
    for (const value of [null, undefined, "text", 0, true, () => true]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});
