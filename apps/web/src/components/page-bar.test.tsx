import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageBar } from "./page-bar.tsx";

describe("PageBar", () => {
  it("links every screen above the current one and leaves the current screen as text", () => {
    const html = renderToStaticMarkup(
      <PageBar trail={[{ href: "/", label: "Workspace" }, { href: "/sources", label: "Sources" }, { label: "Item" }]} />,
    );
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/sources"');
    expect(html).toContain('aria-current="page"');
    expect(html.match(/href=/g)).toHaveLength(2);
  });

  it("keeps one trail on a phone rather than wrapping the bar", () => {
    const html = renderToStaticMarkup(<PageBar trail={[{ href: "/", label: "Workspace" }, { label: "Settings" }]} />);
    expect(html).toContain("flex-nowrap");
  });

  it("keeps the current page out of the link list, where the header's own link already is", () => {
    const html = renderToStaticMarkup(<PageBar trail={[{ href: "/", label: "Workspace" }, { label: "Rules" }]} />);
    expect(html).not.toContain('role="link"');
    expect(html).not.toContain("aria-disabled");
  });

  it("truncates a name that can be anything, such as a Rule's", () => {
    const html = renderToStaticMarkup(<PageBar trail={[{ href: "/rules", label: "Rules" }, { label: "A very long rule name" }]} />);
    expect(html).toContain("truncate");
  });
});
