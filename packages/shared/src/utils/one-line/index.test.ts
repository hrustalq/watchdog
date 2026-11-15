import { describe, expect, it } from "vitest";
import { oneLine } from "./index.ts";

describe("oneLine", () => {
  it("collapses whitespace and trims", () => {
    expect(oneLine("  Acme\n\t Corp  ")).toBe("Acme Corp");
  });

  it("removes a NUL before it collapses", () => {
    expect(oneLine("Ac\0me")).toBe("Acme");
  });

  it("cuts to the longest name a column takes", () => {
    expect(oneLine("x".repeat(250), 200)).toHaveLength(200);
  });

  it("keeps the whole text when no length is given", () => {
    expect(oneLine("x".repeat(250))).toHaveLength(250);
  });

  it("turns an empty or blank value into an empty line", () => {
    expect(oneLine(" \n\t ")).toBe("");
  });
});
