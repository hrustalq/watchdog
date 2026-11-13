import { type Condition, conditionToWords } from "@watchdog/core";
import { describe, expect, it } from "vitest";
import { maxSummaryLength, ruleSummary } from "./rule-summary.ts";

const textOf = (definition: unknown) => {
  const summary = ruleSummary(definition);
  if ("unreadable" in summary) throw new Error("Expected a summary");
  return summary.text;
};

describe("what a rule's row says", () => {
  it("shows a deterministic Classifier's test and the Categories it assigns", () => {
    const definition = {
      classifier: "launches",
      when: { field: "title", op: "contains", value: "launch" },
      assign: ["competitor-launch", "news"],
    };

    expect(textOf(definition)).toBe('Title contains "launch" → competitor-launch, news');
  });

  it("shows the Categories an Agent-backed Classifier may assign", () => {
    const definition = { classifier: "leads", prompt: "Decide whether this is a sales lead.", categories: ["lead", "spam"] };

    expect(textOf(definition)).toBe("May assign lead, spam");
  });

  it("shows a deterministic Extractor Rule's Condition and the fields it extracts", () => {
    const definition = {
      extractor: "versions",
      when: { field: "category", op: "is", value: "security-advisory" },
      fields: [
        { name: "cve", type: "string", from: "title", regex: "(CVE-\\d+-\\d+)" },
        { name: "score", type: "integer", from: "body", regex: "CVSS (\\d)" },
      ],
    };

    expect(textOf(definition)).toBe('Category is security-advisory → cve, score');
  });

  it("shows an Agent-backed Extractor Rule's Condition and the fields it extracts", () => {
    const definition = {
      extractor: "summary",
      when: { field: "source.type", op: "is", value: "rss" },
      prompt: "Name the company each Item is about.",
      fields: [
        { name: "company", type: "string" },
        { name: "tickers", type: "string-array" },
      ],
    };

    expect(textOf(definition)).toBe("Source type is rss → company, tickers");
  });

  it("keeps the brackets of a nested Condition, so it reads the way it runs", () => {
    const definition = {
      classifier: "launches",
      when: {
        all: [
          { field: "title", op: "contains", value: "launch" },
          { any: [{ field: "source.type", op: "is", value: "rss" }, { not: { field: "author", op: "exists" } }] },
        ],
      },
      assign: ["competitor-launch"],
    };

    expect(textOf(definition)).toBe(
      'Title contains "launch" and (Source type is rss or Author is not present) → competitor-launch',
    );
  });

  it("shortens a long Condition on a word, and says the line is cut", () => {
    const words = Array.from({ length: 40 }, (_, index) => `word${String(index + 1).padStart(2, "0")}`);
    const definition = {
      classifier: "launches",
      when: { field: "title", op: "contains", value: words.join(" ") },
      assign: ["competitor-launch"],
    };

    const text = textOf(definition);
    const cut = text.slice(0, -1);
    expect(text.length).toBeLessThanOrEqual(maxSummaryLength + 1);
    expect(text.endsWith("…")).toBe(true);
    // The cut is at a space and keeps whole words: the run it keeps is the run the Condition has.
    expect(`Title contains "${words.join(" ")}" → competitor-launch`).toContain(`${cut} `);
    expect(cut.endsWith(" ")).toBe(false);
  });

  it("shows a short Condition in full", () => {
    const definition = { classifier: "leads", when: { field: "title", op: "contains", value: "hiring" }, assign: ["job"] };

    expect(textOf(definition)).toBe('Title contains "hiring" → job');
  });

  it("cuts before a joiner rather than leaving it with nothing to join", () => {
    const when: Condition = {
      all: [
        { field: "title", op: "contains", value: "a phrase about launches and releases and shipping soon" },
        { field: "url", op: "contains", value: "/blog/2026/announcements" },
        { not: { field: "author", op: "exists" } },
        { field: "source.type", op: "is", value: "rss" },
      ],
    };
    const text = textOf({ classifier: "launches", when, assign: ["competitor-launch"] });
    const cut = text.slice(0, -1);

    expect(text.endsWith("…")).toBe(true);
    expect(`${conditionToWords(when)} → competitor-launch`.startsWith(cut)).toBe(true);
    expect(cut.endsWith(" and")).toBe(false);
  });

  it.each([
    ["an empty definition", {}],
    ["a Condition that tests no field a rule has", { classifier: "x", when: { field: "nope", op: "is", value: 1 }, assign: ["a"] }],
    ["a rule that assigns no Category", { classifier: "x", when: { field: "title", op: "exists" }, assign: [] }],
    ["an Action, which has its own row", { action: "x", when: { field: "title", op: "exists" }, kind: "alert", destinations: ["d"] }],
    ["nothing at all", null],
  ])("says a definition that no longer parses doesn't parse: %s", (_case, definition) => {
    expect(ruleSummary(definition)).toEqual({ unreadable: true });
  });
});
