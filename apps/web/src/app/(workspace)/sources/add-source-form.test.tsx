import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AddSourceForm } from "./add-source-form.tsx";

const html = renderToStaticMarkup(<AddSourceForm />);

/** Every field wrapper whose visibility another Source type decides, with its class list. */
const conditionalWrappers = [...html.matchAll(/<(?:div|fieldset) class="([^"]*\[form:has\(#type-[^"]*)"/g)].map((match) =>
  (match[1] ?? "").replaceAll("&amp;", "&"),
);

/** The class list of the element that wraps the field with this id. */
function wrapperOf(id: string) {
  const before = html.slice(0, html.indexOf(`id="${id}"`));
  const open = before.lastIndexOf('<div class="');
  const start = open + '<div class="'.length;
  return before.slice(start, before.indexOf('"', start)).replaceAll("&amp;", "&");
}

describe("AddSourceForm", () => {
  it("hides every conditional field until a type that owns it is chosen", () => {
    // The Regression: the Region field shipped without the `hidden` base every other conditional
    // field has, so it showed for RSS, GitHub, webhook and Telegram alike. The URL and Schedule
    // fields are the other valid shape: visible by default, with a hide rule for each type they
    // don't belong to.
    expect(conditionalWrappers.length).toBeGreaterThan(6);
    for (const classes of conditionalWrappers) {
      const tokens = classes.split(" ");
      const hiddenByDefault = tokens.includes("hidden");
      const visibleWithExclusions = tokens.includes("flex") && classes.includes("]:hidden");
      expect(hiddenByDefault || visibleWithExclusions).toBe(true);
    }
  });

  it("shows the Website-only Region field for Website and no other type", () => {
    const region = wrapperOf("region");

    expect(region.split(" ")).toContain("hidden");
    expect(region).toContain("[form:has(#type-website:checked)_&]:flex");
    for (const type of ["rss", "github-releases", "github-issues", "github-mentions", "webhook", "telegram"]) {
      expect(region).not.toContain(`#type-${type}:checked`);
    }
  });

  it("offers all seven Source types, with RSS chosen", () => {
    expect(html.match(/name="type"/g)).toHaveLength(7);
    expect(html).toContain('value="rss"');
  });
});
