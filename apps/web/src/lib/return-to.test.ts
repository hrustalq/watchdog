import { describe, expect, it } from "vitest";
import { returnTo, signInPath } from "./return-to.ts";

describe("returnTo", () => {
  it.each(["/", "/some/page?x=1", "/settings", "/a/b?q=%2F&r=1"])("keeps the path on this site %s", (path) => {
    expect(returnTo(path)).toBe(path);
  });

  it.each([
    "//evil.example",
    "//[",
    "https://evil.example",
    "/\\evil.example",
    "\\/evil.example",
    "/\t/evil.example",
    "javascript:alert(1)",
    "some/page",
    "/%2F/evil.example",
    "/%5c/evil.example",
    "",
    null,
    undefined,
    ["/settings"],
  ])("falls back to / for %j", (value) => {
    expect(returnTo(value)).toBe("/");
  });
});

describe("signInPath", () => {
  it("is plain /sign-in when there is nowhere else to go", () => {
    expect(signInPath("/")).toBe("/sign-in");
  });

  it("carries the page to return to in next", () => {
    expect(signInPath("/some/page?x=1")).toBe("/sign-in?next=%2Fsome%2Fpage%3Fx%3D1");
  });
});
