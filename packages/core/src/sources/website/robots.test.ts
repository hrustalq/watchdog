import { describe, expect, it } from "vitest";
import { allows, rulesFor } from "./robots.ts";

const allowed = (robotsTxt: string, path: string) => allows(rulesFor(robotsTxt), path);

describe("robots.txt rules", () => {
  it("applies the group naming Watchdog, in any case, and else the * group", () => {
    const robots = "User-agent: *\nDisallow: /\n\nUser-agent: WATCHDOG\nDisallow: /private\n";
    expect(allowed(robots, "/pricing")).toBe(true);
    expect(allowed(robots, "/private/plans")).toBe(false);
    expect(allowed("User-agent: OtherBot\nDisallow: /\nUser-agent: *\nDisallow: /drafts/", "/drafts/a")).toBe(false);
    expect(allowed("User-agent: OtherBot\nDisallow: /", "/anything")).toBe(true);
  });

  it("uses a Watchdog group with an empty disallow rather than falling back to *", () => {
    expect(allowed("User-agent: *\nDisallow: /\n\nUser-agent: Watchdog\nDisallow:\n", "/pricing")).toBe(true);
  });

  it("merges every group for the same agent, and shares rules among a group's agents", () => {
    const robots = "User-agent: watchdog\nUser-agent: other\nDisallow: /a\n\nUser-agent: Watchdog\nDisallow: /b # old pages";
    expect(allowed(robots, "/a/1")).toBe(false);
    expect(allowed(robots, "/b")).toBe(false);
    expect(allowed(robots, "/c")).toBe(true);
  });

  it("lets the longest match decide, and allow win a tie", () => {
    const robots = "User-agent: *\nDisallow: /docs\nAllow: /docs/public\nDisallow: /tie\nAllow: /tie";
    expect(allowed(robots, "/docs/secret")).toBe(false);
    expect(allowed(robots, "/docs/public/page")).toBe(true);
    expect(allowed(robots, "/tie")).toBe(true);
  });

  it("matches * as any run of characters and a final $ as the end", () => {
    const robots = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /shop/*/cart\nDisallow: /search?";
    expect(allowed(robots, "/files/report.pdf")).toBe(false);
    expect(allowed(robots, "/files/report.pdf?download=1")).toBe(true);
    expect(allowed(robots, "/shop/shoes/cart")).toBe(false);
    expect(allowed(robots, "/search?q=price")).toBe(false);
    expect(allowed(robots, "/searching")).toBe(true);
  });

  it("compares percent-encoding alike, and always allows robots.txt itself", () => {
    expect(allowed("User-agent: *\nDisallow: /café", "/caf%C3%A9/menu")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /a%2fb", "/a%2Fb")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /", "/robots.txt")).toBe(true);
  });
});
