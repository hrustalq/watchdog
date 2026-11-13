import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RatingControls } from "./correct-rating.tsx";

/** The text a screen reader reads in the scale's level buttons and its line of meaning. */
const words = (html: string) => html.replace(/<[^>]*>/g, "").replace(/&#x27;/g, "'");

/** What a sighted reader gets with colour taken away, which is what the mark has to survive. */
const visible = (html: string) => words(html.replace(/<span class="sr-only">[^<]*<\/span>/g, ""));

/** One axis's markup: from its group to the other axis's, which is where its meaning line ends. */
function axis(html: string, name: "Severity" | "Importance") {
  const start = html.indexOf(`aria-label="Correct ${name}"`);
  const other = name === "Severity" ? "Importance" : "Severity";
  const end = html.indexOf(`aria-label="Correct ${other}"`, start);
  return html.slice(start, end === -1 ? undefined : end);
}

const controls = (originalRating?: { severity: number | null; importance: number | null }) =>
  renderToStaticMarkup(<RatingControls itemId="item" severity={5} importance={2} originalRating={originalRating} />);

describe("RatingControls", () => {
  it("marks the Agent's level, in words and an outline, on the axis the user corrected", () => {
    const severity = axis(controls({ severity: 3, importance: 2 }), "Severity");

    expect(severity).toContain("border-dashed");
    // The outline is one mark, on the level the Agent gave and not on the level it was corrected to.
    expect(severity.match(/border-dashed/g)).toHaveLength(1);
    expect(visible(severity)).toContain("the Agent rated this 3 of 5");
    expect(words(severity)).toContain("Set Severity to 3 of 5, plan for it this month, which was the Agent's Rating");
  });

  it("leaves the axis the user didn't touch unmarked", () => {
    const importance = axis(controls({ severity: 3, importance: 2 }), "Importance");

    expect(importance).not.toContain("border-dashed");
    expect(visible(importance)).not.toContain("Agent");
    expect(words(importance)).not.toContain("Agent");
  });

  it("marks nothing without a Correction", () => {
    const html = controls();

    expect(html).not.toContain("border-dashed");
    expect(html).not.toContain("Agent");
    expect(visible(axis(html, "Severity"))).toContain("act today");
  });

  it("marks nothing for an Item the user rated while it was unrated, because the Agent gave no level", () => {
    const html = controls({ severity: null, importance: null });

    expect(html).not.toContain("border-dashed");
    expect(html).not.toContain("Agent");
  });
});
