import { describe, expect, it } from "vitest";
import { httpUrl } from "./index.ts";

describe("httpUrl", () => {
  it("takes an http or https URL and trims it", () => {
    expect(httpUrl("  https://example.com/a?b=1  ")?.href).toBe("https://example.com/a?b=1");
    expect(httpUrl("http://example.com")?.protocol).toBe("http:");
  });

  it("refuses another scheme", () => {
    expect(httpUrl("ftp://example.com")).toBeNull();
    expect(httpUrl("javascript:alert(1)")).toBeNull();
    expect(httpUrl("file:///etc/passwd")).toBeNull();
  });

  it("refuses text that isn't an absolute URL", () => {
    expect(httpUrl("example.com")).toBeNull();
    expect(httpUrl("")).toBeNull();
  });

  it("lets the URL parser normalise the host", () => {
    expect(httpUrl("HTTPS://Example.COM/Path")?.href).toBe("https://example.com/Path");
  });
});
