import { describe, expect, it } from "vitest";
import { withoutNul } from "./index.ts";

describe("withoutNul", () => {
  it("removes every U+0000", () => {
    expect(withoutNul("a\0b\0\0c")).toBe("abc");
  });

  it("leaves the rest of the text alone", () => {
    expect(withoutNul("  Acme\nCorp  ")).toBe("  Acme\nCorp  ");
  });

  it("keeps an emoji and its surrogate pair", () => {
    expect(withoutNul("hi \u{1F600}")).toBe("hi \u{1F600}");
  });
});
