import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignalLine } from "./signal-line.tsx";

describe("SignalLine", () => {
  it("reports a failure as a red lamp and red words", () => {
    const html = renderToStaticMarkup(<SignalLine tone="alarm">Last send failed</SignalLine>);
    expect(html).toContain("bg-alarm");
    expect(html).toContain("text-alarm");
  });

  it("warns without claiming a failure: a caution lamp and ink", () => {
    const html = renderToStaticMarkup(<SignalLine tone="caution">This rule can&apos;t run yet</SignalLine>);
    expect(html).toContain("bg-caution");
    expect(html).not.toContain("text-alarm");
  });

  it("keeps the lamp visible in forced colors and out of the accessibility tree", () => {
    const html = renderToStaticMarkup(<SignalLine tone="alarm">Failed</SignalLine>);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("forced-colors:bg-[CanvasText]");
  });
});
