import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Section } from "./section.tsx";

describe("Section", () => {
  it("names itself with its heading, so aria-labelledby never points at nothing", () => {
    const html = renderToStaticMarkup(
      <Section id="watched" title="Watching 2 Sources">
        Rows
      </Section>,
    );
    expect(html).toContain('aria-labelledby="watched"');
    expect(html).toContain('id="watched"');
    expect(html).toContain("text-title");
  });

  it("groups the description with the heading, not with the content", () => {
    const html = renderToStaticMarkup(
      <Section id="s" title="Rules" description="Applies from now on">
        Content
      </Section>,
    );
    expect(html).toContain("max-w-[70ch]");
    expect(html).toContain("flex min-w-0 flex-col gap-1");
  });

  it("draws the three surfaces the screens need", () => {
    expect(renderToStaticMarkup(<Section id="a" title="A" tone="panel" />)).toContain("rounded-lg border p-4");
    expect(renderToStaticMarkup(<Section id="b" title="B" tone="raised" />)).toContain("bg-card");
    expect(renderToStaticMarkup(<Section id="c" title="C" tone="inset" gap={4} />)).toContain("p-4");
  });

  it("makes the heading a focus target only where a row can disappear", () => {
    const plain = renderToStaticMarkup(<Section id="a" title="A" />);
    const focusable = renderToStaticMarkup(<Section id="b" title="B" focusableTitle />);
    expect(plain).not.toContain('tabindex="-1"');
    expect(focusable).toContain('tabindex="-1"');
  });
});
