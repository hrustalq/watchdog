import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CenteredColumn, CenteredPage } from "./centered-page.tsx";

describe("CenteredPage", () => {
  it("owns the height it has and centres one short column", () => {
    const html = renderToStaticMarkup(<CenteredPage>Sign in</CenteredPage>);
    expect(html).toContain("<main");
    expect(html).toContain("items-center");
    expect(html).toContain("flex-1");
  });

  it("renders a div when the Workspace shell already owns the main landmark", () => {
    const html = renderToStaticMarkup(<CenteredPage as="div">Nothing here</CenteredPage>);
    expect(html).toContain("<div");
    expect(html).not.toContain("<main");
  });
});

describe("CenteredColumn", () => {
  it("caps a form at 24rem and keeps the 24px step", () => {
    const html = renderToStaticMarkup(<CenteredColumn>Form</CenteredColumn>);
    expect(html).toContain("max-w-sm");
    expect(html).toContain("gap-6");
  });
});
