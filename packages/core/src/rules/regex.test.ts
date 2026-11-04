import { describe, expect, it } from "vitest";
import { captureRegexError, firstCapture, regexError, regexMatches } from "./regex.ts";

describe("regexError", () => {
  it("accepts a pattern with the inline case-insensitive flag", () => {
    expect(regexError("(?i)launch|introducing")).toBeUndefined();
  });

  it("refuses a pattern that doesn't compile, quoting it", () => {
    expect(regexError("(unclosed")).toContain('"(unclosed"');
  });

  it("refuses lookaround, which the engine doesn't have", () => {
    expect(regexError("(?=a)b")).toContain("(?=");
  });

  it("refuses a repeat count over 1,000", () => {
    expect(regexError("a{1001}")).toContain("{1001}");
  });

  it("accepts a pattern of exactly 1,000 instructions", () => {
    expect(regexError("[a-z]{1,499}[bc]")).toBeUndefined();
  });

  it("refuses a pattern of 2,001 instructions as too complex", () => {
    expect(regexError("a{1,1000}")).toContain("too complex");
  });

  it("refuses the 20-branch alternation from ADR 0026 as too complex", () => {
    expect(regexError(Array(20).fill("a{1,1000}").join("|"))).toContain("too complex");
  });
});

describe("captureRegexError", () => {
  it("accepts a pattern with a capture group", () => {
    expect(captureRegexError("(CVE-\\d+-\\d+)")).toBeUndefined();
  });

  it("refuses a pattern with no capture group, since it could never extract anything", () => {
    expect(captureRegexError("CVE-\\d+-(?:\\d+)")).toContain("capture group");
  });

  it("still refuses what regexError refuses", () => {
    expect(captureRegexError("(a{1,1000})")).toContain("too complex");
  });
});

describe("regexMatches", () => {
  it("finds the pattern anywhere in the text", () => {
    expect(regexMatches("launch", "We launch today")).toBe(true);
    expect(regexMatches("launch", "We shipped today")).toBe(false);
  });

  it("honours (?i)", () => {
    expect(regexMatches("(?i)launch", "LAUNCH day")).toBe(true);
  });

  it("finishes a catastrophic-backtracking pattern on 32 KB in under 100 ms", () => {
    const text = `${"a".repeat(32 * 1024)}b`;
    const started = performance.now();
    expect(regexMatches("(a+)+$", text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("firstCapture", () => {
  it("returns the first capture group of the first match", () => {
    expect(firstCapture("v(\\d+)\\.(\\d+)", "from v1.2 to v3.4")).toBe("1");
  });

  it("returns undefined when nothing matches", () => {
    expect(firstCapture("v(\\d+)", "no version")).toBeUndefined();
  });

  it("returns undefined when the match skips the group", () => {
    expect(firstCapture("v(\\d+)?x", "vx")).toBeUndefined();
  });
});
