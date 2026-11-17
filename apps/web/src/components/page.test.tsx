import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Page, PageHeader } from "./page.tsx";

describe("Page", () => {
  it("lets a wide screen fill the shell's inset instead of a centred strip", () => {
    const html = renderToStaticMarkup(<Page>Content</Page>);
    expect(html).toContain("max-w-none");
    expect(html).not.toContain("max-w-3xl");
    expect(html).toContain("gap-8");
    expect(html).toContain("mx-auto");
  });

  it("stays a column, because the Workspace inset already owns the page's main landmark", () => {
    expect(renderToStaticMarkup(<Page>Content</Page>)).not.toContain("<main");
  });

  it("narrows to 42rem for a form and keeps a caller's flex fill", () => {
    const html = renderToStaticMarkup(
      <Page width="narrow" gap={6} className="flex-1">
        Content
      </Page>,
    );
    expect(html).toContain("max-w-2xl");
    expect(html).toContain("gap-6");
    expect(html).toContain("flex-1");
    expect(html).not.toContain("gap-8");
  });

  it("can drop its gap where the child owns the spacing", () => {
    expect(renderToStaticMarkup(<Page gap="none">Content</Page>)).not.toContain("gap-");
  });
});

describe("PageHeader", () => {
  it("renders one h1, its line and the actions on the title's row", () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Feed" description="Latest first" actions={<span>Correct</span>} />,
    );
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("text-headline");
    expect(html).toContain("Latest first");
    expect(html).toContain("justify-between");
  });

  it("renders no description line when there is nothing to say", () => {
    const html = renderToStaticMarkup(<PageHeader title="Model" />);
    expect(html).not.toContain("text-muted-foreground");
  });
});
