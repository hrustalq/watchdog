import { describe, expect, it } from "vitest";
import type { AgentExtractorRule } from "../rules/schema.ts";
import { ratingSchema } from "./rating.ts";

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

  it.each(["", "  \n"])("refuses a blank summary or reasoning: %j", (text) => {
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
