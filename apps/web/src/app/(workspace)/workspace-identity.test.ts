import { describe, expect, it } from "vitest";
import { nameFromEmail, userMark } from "./workspace-identity";

describe("userMark", () => {
  it("takes the first two letters of the email", () => {
    expect(userMark("eldar@example.com")).toBe("EL");
  });

  it("falls back to a question mark rather than an empty avatar", () => {
    expect(userMark("   ")).toBe("?");
  });
});

describe("nameFromEmail", () => {
  it("drops the domain", () => {
    expect(nameFromEmail("eldar@example.com")).toBe("eldar");
  });

  it("keeps an address that has no local part", () => {
    expect(nameFromEmail("@example.com")).toBe("@example.com");
  });
});
