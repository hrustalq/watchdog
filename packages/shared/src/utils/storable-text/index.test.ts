import { describe, expect, it } from "vitest";
import { storableText } from "./index.ts";

describe("storableText", () => {
  it("removes a NUL", () => {
    expect(storableText("a\0b")).toBe("ab");
  });

  it("replaces half a surrogate pair with U+FFFD", () => {
    expect(storableText("a\uD800b")).toBe("a\uFFFDb");
  });

  it("keeps a whole pair", () => {
    expect(storableText("a\u{1F600}b")).toBe("a\u{1F600}b");
  });

  it("leaves ordinary text alone", () => {
    expect(storableText("Acme shipped 2.0\n")).toBe("Acme shipped 2.0\n");
  });
});
