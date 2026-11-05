import { describe, expect, it } from "vitest";
import type { AgentExtractorRule } from "../rules/schema.ts";
import { ratingAnchor, ratingMeaning, ratingSchema, ratingTask } from "./rating.ts";

const rated = { summary: "A summary", reasoning: "Because", severity: 3, importance: 3 };

const rule = (...fields: AgentExtractorRule["fields"]): AgentExtractorRule => ({
  extractor: "pricing",
  when: { field: "title", op: "exists" },
  prompt: "Pull it out",
  fields,
});

describe("ratingSchema", () => {
  it.each([0, 6, 2.5, "3", null])("refuses %s as a level", (level) => {
    expect(ratingSchema([]).safeParse({ ...rated, severity: level }).success).toBe(false);
    expect(ratingSchema([]).safeParse({ ...rated, importance: level }).success).toBe(false);
  });

  it.each(["", "  \n", "\0 "])("refuses a blank summary or reasoning: %j", (text) => {
    expect(ratingSchema([]).safeParse({ ...rated, summary: text }).success).toBe(false);
    expect(ratingSchema([]).safeParse({ ...rated, reasoning: text }).success).toBe(false);
  });

  it("keeps a rule's declared keys and drops any other", () => {
    const schema = ratingSchema([rule({ name: "plan", type: "string" })]);

    expect(schema.parse({ ...rated, field_plan: "Pro", categories: ["made-up"] })).toEqual({
      ...rated,
      field_plan: "Pro",
    });
  });

  it("requires a declared key, which may be null", () => {
    const schema = ratingSchema([rule({ name: "plan", type: "string" })]);

    expect(schema.safeParse(rated).success).toBe(false);
    expect(schema.safeParse({ ...rated, field_plan: null }).success).toBe(true);
  });

  it.each([
    ["string", 5],
    ["integer", "five"],
    ["integer", 1.5],
    ["string-array", "a"],
    ["integer-array", [1.5]],
  ] as const)("refuses a %s field holding %j", (type, value) => {
    const schema = ratingSchema([rule({ name: "plan", type })]);

    expect(schema.safeParse({ ...rated, field_plan: value }).success).toBe(false);
  });

  it("keeps the oldest rule's type for a field two rules declare", () => {
    const schema = ratingSchema([
      rule({ name: "plan", type: "integer" }),
      rule({ name: "plan", type: "string" }),
    ]);

    expect(schema.safeParse({ ...rated, field_plan: 5 }).success).toBe(true);
    expect(schema.safeParse({ ...rated, field_plan: "Pro" }).success).toBe(false);
  });
});

describe("ratingTask", () => {
  it("sends the Agent the Rating scale, word for word", () => {
    expect(ratingTask([], "en")).toContain(`Severity, how urgent or harmful the Item is:
5: act today, e.g. an outage, or a security advisory in something the user depends on.
4: act this week, e.g. a serious bug, or a breaking change about to reach the user.
3: plan for it this month, e.g. a bug with a workaround, or a deprecation with a date.
2: minor, with no deadline, e.g. a cosmetic bug or a small complaint.
1: nothing urgent or harmful, e.g. a feature request, a competitor's launch, or routine news.

Importance, how much the Item matters to the user:
5: directly about the user's product, or a key competitor or customer.
4: about something else the Profile names, e.g. another competitor, a dependency or a tracked market.
3: about the user's field in general, and useful to know, e.g. a trend or a product in an adjacent space.
2: only loosely related, e.g. general news that touches one of the user's interests.
1: unrelated to anything in the Profile, e.g. off-topic posts or spam.

Judge importance`);
  });
});

describe("ratingMeaning", () => {
  it.each([
    ["severity", 5, "act today"],
    ["severity", 4, "act this week"],
    ["severity", 1, "nothing urgent or harmful"],
    ["importance", 5, "directly about the user's product, or a key competitor or customer"],
    ["importance", 2, "only loosely related"],
  ] as const)("says what %s %i means, without its example", (axis, level, meaning) => {
    expect(ratingMeaning(axis, level)).toBe(meaning);
  });

  it.each([0, 6])("refuses level %i, which isn't on the scale", (level) => {
    expect(() => ratingMeaning("severity", level)).toThrow();
  });
});

describe("ratingAnchor", () => {
  it("gives a level's meaning with its example", () => {
    expect(ratingAnchor({ meaning: "act today", example: "an outage" })).toBe("act today, e.g. an outage");
  });

  it("gives only the meaning of a level with no example", () => {
    expect(ratingAnchor({ meaning: "directly about the user's product" })).toBe("directly about the user's product");
  });
});
