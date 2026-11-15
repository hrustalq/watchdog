import { describe, expect, it } from "vitest";
import { sha256Hex } from "./index.ts";

describe("sha256Hex", () => {
  it("hashes text", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes an empty value", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes bytes the same way as the text they hold", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });

  it("keeps upper case out of the digest", () => {
    expect(sha256Hex("ABC")).toMatch(/^[0-9a-f]{64}$/);
  });
});
