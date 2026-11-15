import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Notice } from "./notice.tsx";

describe("Notice", () => {
  it("takes focus from code and leaves the role to say whether it interrupts", () => {
    const html = renderToStaticMarkup(
      <Notice role="alert">That didn&apos;t work.</Notice>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('tabindex="-1"');
  });

  it("draws news as the quiet well by default", () => {
    const html = renderToStaticMarkup(<Notice role="status">Saved.</Notice>);
    expect(html).toContain("bg-muted");
    expect(html).toContain("px-3 py-2");
    expect(html).not.toContain("text-alarm");
  });

  it("draws a refusal as the alarm-red well, never a solid red slab", () => {
    const html = renderToStaticMarkup(
      <Notice role="alert" tone="failed">
        Refused.
      </Notice>,
    );
    expect(html).toContain("bg-destructive/10");
    expect(html).toContain("text-alarm");
    expect(html).not.toContain("bg-alarm");
  });

  it("warns in amber without claiming a failure", () => {
    const html = renderToStaticMarkup(
      <Notice role="status" tone="caution">
        Nothing was stored.
      </Notice>,
    );
    expect(html).toContain("bg-caution/10");
    expect(html).toContain("text-caution");
    expect(html).not.toContain("text-alarm");
  });

  it("states a refusal in red inside a panel, with no second well", () => {
    const html = renderToStaticMarkup(
      <Notice role="alert" tone="alarm">
        That isn&apos;t a URL.
      </Notice>,
    );
    expect(html).toContain("text-alarm");
    expect(html).not.toContain("bg-destructive/10");
  });

  it("keeps its look when it sits inside a panel that already has a surface", () => {
    const html = renderToStaticMarkup(
      <Notice role="status" tone="plain" className="hidden">
        Copy this.
      </Notice>,
    );
    expect(html).toContain("hidden");
    expect(html).not.toContain("bg-muted");
  });
});
