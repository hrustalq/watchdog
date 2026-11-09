import { describe, expect, it } from "vitest";
import { normalise, readPage, regionError } from "./page.ts";

describe("regionError", () => {
  it("accepts the selectors css-select can match", () => {
    expect(regionError("#pricing .plan")).toBeUndefined();
    expect(regionError("main > section:nth-child(2), aside")).toBeUndefined();
  });

  it("refuses a selector that doesn't parse, can't be matched, uses :has() or runs too long", () => {
    expect(regionError("main[data-plan")).toBe("invalid");
    expect(regionError("p::before")).toBe("invalid");
    expect(regionError("section:has(.price)")).toBe("has");
    expect(regionError("main :is(p, div:has(span))")).toBe("has");
    expect(regionError(`.${"a".repeat(1000)}`)).toBe("too-long");
  });
});

describe("readPage", () => {
  it("reads a page with no <body> whole, and its URL stands in for a missing title", () => {
    expect(readPage("<!doctype html><p>Plain fragment</p>", undefined)).toEqual({
      title: null,
      html: "<p>Plain fragment</p>",
      text: "Plain fragment",
    });
  });

  it("refuses a page nested more than 1,000 elements deep", () => {
    const deep = `<body>${"<div>".repeat(1001)}x</body>`;
    expect(() => readPage(deep, "div")).toThrow("The page is nested more than 1000 elements deep, too deep to read");
    expect(readPage(`<body>${"<div>".repeat(998)}x</body>`, undefined).text).toBe("x");
  });
});

describe("normalise", () => {
  it("drops U+0000, which Postgres can't keep in the Baseline", () => {
    expect(normalise("a\0b", [])).toBe("ab");
  });

  it("drops ignore matches and blank lines, and collapses whitespace in each line", () => {
    expect(normalise("Price:   $20\n\n  Updated 5 minutes ago \nVisits: 991", [String.raw`Updated \d+ minutes ago`])).toBe(
      "Price: $20\nVisits: 991",
    );
  });
});
