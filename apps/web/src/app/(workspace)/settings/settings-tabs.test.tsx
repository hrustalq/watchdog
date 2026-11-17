import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsTabs } from "./settings-tabs.tsx";

const render = (current: Parameters<typeof SettingsTabs>[0]["current"], admin = false) =>
  renderToStaticMarkup(<SettingsTabs current={current} workspaceName="Acme" admin={admin} />);

/** The links a render produced, in DOM order, with their href, label and whether each is the current tab. */
const links = (html: string) =>
  [...html.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map(([, attributes = "", label = ""]) => {
    const classes = (/class="([^"]*)"/.exec(attributes)?.[1] ?? "").split(/\s+/);
    return {
      href: /href="([^"]*)"/.exec(attributes)?.[1],
      label: label.trim(),
      current: attributes.includes('aria-current="page"'),
      well: classes.includes("bg-muted"),
    };
  });

describe("SettingsTabs", () => {
  it("lists the tabs in the order the page shows them, each linking its own URL", () => {
    expect(links(render("delivery")).map((link) => [link.label, link.href])).toEqual([
      ["Delivery", "/settings?tab=delivery"],
      ["Retention", "/settings?tab=retention"],
      ["Health alerts", "/settings?tab=health"],
      ["Workspace", "/settings?tab=workspace"],
    ]);
  });

  it("marks the current tab once, in the well navigation uses for the current section", () => {
    const rendered = links(render("retention"));

    expect(rendered.filter((link) => link.current).map((link) => link.label)).toEqual(["Retention"]);
    expect(rendered.filter((link) => link.well).map((link) => link.label)).toEqual(["Retention"]);
  });

  it("keeps Instance for an admin, the only one who can open it", () => {
    expect(links(render("delivery", true)).map((link) => link.label)).toContain("Instance");
    expect(links(render("delivery", true))).toHaveLength(5);
    expect(render("delivery")).not.toContain("/settings?tab=instance");
  });

  it("is a nav of links, so it works without JavaScript", () => {
    const html = render("health");

    expect(html).toMatch(/^<nav\b/);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("role=\"tab\"");
  });

  it("names the Workspace it is the settings of, so it says whose settings these are", () => {
    expect(render("delivery")).toContain('aria-label="Acme settings"');
  });

  it("scrolls sideways on a phone instead of wrapping into a tall block", () => {
    const html = render("delivery");

    expect(html).toContain("overflow-x-auto");
    for (const link of links(html)) expect(link.href).toBeDefined();
    expect([...html.matchAll(/<a\b[^>]*>/g)].every(([tag]) => tag.includes("shrink-0") && tag.includes("whitespace-nowrap"))).toBe(
      true,
    );
  });
});
