import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthChip } from "./health.tsx";

const words = (html: string) => html.replace(/<[^>]*>/g, "");
/** What a sighted reader gets with colour taken away. */
const visible = (html: string) => words(html.replace(/<span class="sr-only">[^<]*<\/span>/g, ""));
/** What a screen reader reads, one text node. */
const spoken = (html: string) => [...html.matchAll(/<span class="sr-only">([^<]*)<\/span>/g)].map(([, text]) => text);

describe("HealthChip", () => {
  it("says the Health in words, to the eye and to a screen reader, whatever the colour", () => {
    const chip = (health: "ok" | "degraded" | "failing") => renderToStaticMarkup(<HealthChip health={health} />);
    expect(visible(chip("ok"))).toBe("OK");
    expect(visible(chip("degraded"))).toBe("Degraded");
    expect(visible(chip("failing"))).toBe("Failing");
    expect(spoken(chip("ok"))).toEqual(["Health: ok"]);
    expect(spoken(chip("degraded"))).toEqual(["Health: degraded"]);
    expect(spoken(chip("failing"))).toEqual(["Health: failing"]);
  });

  it("is red when failing, amber when degraded, and neither when ok", () => {
    expect(renderToStaticMarkup(<HealthChip health="failing" />)).toContain("text-alarm");
    expect(renderToStaticMarkup(<HealthChip health="degraded" />)).toContain("text-caution");
    const ok = renderToStaticMarkup(<HealthChip health="ok" />);
    expect(ok).not.toContain("alarm");
    expect(ok).not.toContain("caution");
  });
});
