import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelList, PanelRow } from "./panel-list.tsx";

describe("PanelList", () => {
  it("draws the shared hairline panel around ordered, unordered and plain rows", () => {
    for (const as of ["ul", "ol", "div"] as const) {
      const html = renderToStaticMarkup(<PanelList as={as}>Row</PanelList>);
      expect(html).toContain(`<${as}`);
      expect(html).toContain("divide-y rounded-lg border");
    }
  });

  it("keeps a caller's extra surface, such as the Log's well", () => {
    expect(renderToStaticMarkup(<PanelList as="ol" className="bg-muted text-data">Row</PanelList>)).toContain("bg-muted text-data");
  });
});

describe("PanelRow", () => {
  it("stacks its controls under the title on a phone and beside it from sm", () => {
    const html = renderToStaticMarkup(<PanelRow>Row</PanelRow>);
    expect(html).toContain("sm:flex-row");
    expect(html).toContain("sm:items-start");
    expect(html).toContain("sm:justify-between");
  });
});
