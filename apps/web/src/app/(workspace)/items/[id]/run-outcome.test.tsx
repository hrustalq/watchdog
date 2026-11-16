import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ManualRun } from "@/lib/feed";
import { RunOutcome } from "./run-outcome.tsx";

/** What a sighted reader gets, line by line, with colour taken away. */
const visible = (html: string) =>
  html
    .replace(/<span class="sr-only">[^<]*<\/span>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'");

const run = (parts: Partial<ManualRun>): ManualRun => ({
  id: 1,
  message: "Manual run",
  failed: false,
  extractor: "Affected plan",
  fields: [],
  empty: [],
  problems: [],
  detail: undefined,
  ...parts,
});

describe("RunOutcome", () => {
  it("puts the rule's name on a line of its own, then the fields the run filled", () => {
    const html = renderToStaticMarkup(<RunOutcome run={run({ fields: ["plan"], empty: ["author"] })} />);
    expect(html).toContain('<span class="block font-medium"><span class="sr-only">Extractor Rule </span>Affected plan</span>');
    expect(visible(html)).toBe("Affected planFilled plan.Found no value for author.");
    // A run that filled a field is the expected outcome, so it wears neither signal colour.
    expect(html).toContain("bg-muted");
    expect(html).not.toContain("caution");
    expect(html).not.toContain("alarm");
  });

  it("says a run that stored nothing found nothing, and gives it the Caution Amber lamp", () => {
    const html = renderToStaticMarkup(<RunOutcome run={run({ empty: ["plan", "author"] })} />);
    expect(visible(html)).toBe("Affected planFound no value for plan, author.Nothing was stored.");
    expect(html).toContain("text-caution");
    expect(html).toContain("bg-caution/10");
    expect(html).toContain("bg-caution");
  });

  it("names each field the run couldn't store and why", () => {
    const html = renderToStaticMarkup(
      <RunOutcome run={run({ problems: [{ name: "plan", reason: "another rule already filled it" }] })} />,
    );
    expect(visible(html)).toBe("Affected planCouldn't store plan: another rule already filled it");
    expect(html).toContain("text-caution");
  });

  it("keeps a failed run's reason and the word that the earlier values stayed", () => {
    const html = renderToStaticMarkup(<RunOutcome run={run({ failed: true, detail: "The model is down" })} />);
    expect(visible(html)).toBe("Affected planThe run failed: The model is downWhat this rule found before stays as it was.");
    expect(html).toContain("text-alarm");
    expect(html).toContain('role="alert"');
  });

  it("shows an older failed row's sentence, which names the rule and its reason itself", () => {
    const said = "Manual run: Extractor Rule Affected plan failed: the rule was deleted during the run";
    const html = renderToStaticMarkup(<RunOutcome run={run({ failed: true, message: said })} />);
    expect(visible(html)).toBe(`${said}What this rule found before stays as it was.`);
    expect(html).toContain("text-alarm");
  });

  it("renders a rule's name and a field's name as text, whatever HTML they hold", () => {
    const html = renderToStaticMarkup(
      <RunOutcome run={run({ extractor: "<b>Plans</b>", fields: ['<img src=x onerror="alert(1)">'] })} />,
    );
    expect(html).toContain("&lt;b&gt;Plans&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<b>Plans</b>");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
  });
});
