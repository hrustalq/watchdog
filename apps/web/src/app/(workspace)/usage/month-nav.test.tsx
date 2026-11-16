import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MonthNav } from "./month-nav.tsx";

const CURRENT = "2026-11";

/** The month links a render produced, in DOM order, with the fixed width each took. */
const links = (html: string) =>
  [...html.matchAll(/<a\b[^>]*>/g)].map(([tag]) => ({
    href: /href="([^"]*)"/.exec(tag)?.[1],
    width: /\bw-\d+\b/.exec(tag)?.[0],
  }));

/** Every fixed width the markup carries, so a missing direction's empty slot is counted too. */
const widths = (html: string) => html.match(/\bw-\d+\b/g) ?? [];

const render = (older: string | undefined, newer: string | undefined) =>
  renderToStaticMarkup(<MonthNav current={CURRENT} older={older} newer={newer} />);

describe("MonthNav", () => {
  it("puts the older link first, so the keyboard reaches it before the newer one", () => {
    expect(links(render("2026-10", "2026-11")).map((link) => link.href)).toEqual(["/usage?month=2026-10", "/usage"]);
  });

  it("gives both directions the same fixed width, so a longer label can't move either", () => {
    const [older, newer] = links(render("2026-09", "2026-11"));
    expect(older?.width).toMatch(/^w-\d+$/);
    expect(newer?.width).toBe(older?.width);
  });

  it("reserves the missing direction's slot and leaves no control behind it", () => {
    // The current month has nothing newer to go to, which is where the older link used to be last.
    const html = render("2026-10", undefined);
    expect(links(html)).toHaveLength(1);
    expect(html).not.toContain("tabindex");
    expect(html).not.toContain("<button");
    const [older] = links(html);
    expect(widths(html)).toEqual([older?.width, older?.width]);
  });

  it("keeps the slots the same width whatever the labels are", () => {
    const may = links(render("2026-05", "2026-11"));
    const september = links(render("2026-09", "2026-11"));
    expect(may.map((link) => link.width)).toEqual(september.map((link) => link.width));
  });

  it("renders nothing when no month is reachable", () => {
    expect(render(undefined, undefined)).toBe("");
  });
});
