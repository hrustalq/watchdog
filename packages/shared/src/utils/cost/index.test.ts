import { describe, expect, it } from "vitest";
import { addCosts, formatCost, toCost } from "./index.ts";

describe("adding costs", () => {
  it("adds without a float's rounding", () => {
    expect(addCosts("0.1", "0.2")).toBe("0.3");
  });

  it("keeps a null only when neither side has a cost", () => {
    expect(addCosts(null, null)).toBeNull();
    expect(addCosts(null, "1.5")).toBe("1.5");
    expect(addCosts("1.5", null)).toBe("1.5");
  });

  it("adds costs of different scales exactly", () => {
    expect(addCosts("0.0000125", "1234.5")).toBe("1234.5000125");
  });
});

describe("a cost's canonical spelling", () => {
  it("drops trailing zeros and the database's scale", () => {
    expect(toCost("7.5000000000000000")).toBe("7.5");
    expect(toCost("0.000000000000000000")).toBe("0");
  });

  it("writes a small value without an exponent", () => {
    expect(toCost("1e-7")).toBe("0.0000001");
  });
});

describe("formatting a cost", () => {
  it("shows four decimals and groups thousands", () => {
    expect(formatCost("3.5")).toBe("3.5000");
    expect(formatCost("1234.5")).toBe("1,234.5000");
    expect(formatCost("0")).toBe("0.0000");
  });

  it("never rounds a small cost down to nothing", () => {
    expect(formatCost("0.000003")).toBe("<0.0001");
    expect(formatCost("0.0001")).toBe("0.0001");
  });

  it("rounds half up at the fifth decimal", () => {
    expect(formatCost("1.23445")).toBe("1.2345");
    expect(formatCost("1.23444")).toBe("1.2344");
  });
});
