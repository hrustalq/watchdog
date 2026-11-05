import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoryList, Rating } from "./rating.tsx";

/** What a reader gets with colour taken away: the text, which is also what a screen reader reads. */
const words = (html: string) => html.replace(/<[^>]*>/g, "");

describe("Rating", () => {
  it("names both axes in words, on the 1–5 scale, whatever the colour", () => {
    for (const severity of [1, 2, 3, 4, 5]) {
      const html = renderToStaticMarkup(<Rating severity={severity} importance={2} />);
      expect(words(html)).toBe(`Severity ${String(severity)} of 5Importance 2 of 5`);
    }
  });

  it("gives Severity the signal colours: high is red, medium amber, low neither", () => {
    const severityChip = (severity: number) => renderToStaticMarkup(<Rating severity={severity} importance={1} />);
    for (const high of [4, 5]) expect(severityChip(high)).toContain("text-alarm");
    expect(severityChip(3)).toContain("text-caution");
    for (const low of [1, 2]) {
      expect(severityChip(low)).not.toContain("alarm");
      expect(severityChip(low)).not.toContain("caution");
    }
  });

  it("keeps red and amber off Importance, which says what matters and not what's wrong", () => {
    const html = renderToStaticMarkup(<Rating severity={1} importance={5} />);
    expect(html).not.toContain("alarm");
    expect(html).not.toContain("caution");
  });

  it("says Unrated in words, with no number and no lamp, so it can't read as a low score", () => {
    const html = renderToStaticMarkup(<Rating severity={null} importance={null} />);
    expect(words(html)).toBe("Unrated");
    expect(html).not.toContain("rounded-full");
    expect(html).not.toContain("alarm");
  });
});

describe("CategoryList", () => {
  it("lists each Category under a label, and renders HTML in one as text", () => {
    const html = renderToStaticMarkup(<CategoryList categories={["release", "<b>odd</b>"]} />);
    expect(html).toContain('aria-label="Categories"');
    expect(html).toContain("release");
    expect(html).toContain("&lt;b&gt;odd&lt;/b&gt;");
    expect(html).not.toContain("<b>");
  });

  it("renders nothing with no Categories", () => {
    expect(renderToStaticMarkup(<CategoryList categories={[]} />)).toBe("");
  });
});
