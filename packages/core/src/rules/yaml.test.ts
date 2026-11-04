import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { evaluateCondition } from "./condition.ts";
import { type Condition, deterministicClassifierSchema, type Rule, ruleSchema } from "./schema.ts";
import { ruleFromYaml, ruleToYaml } from "./yaml.ts";

// The example on the Rule model page, verbatim. CI doesn't check out the docs submodule.
const example = `
classifier: competitor-launch
when:
  all:
    - { field: source.type, op: is, value: rss }
    - { field: title, op: matches, value: "(?i)launch|introducing" }
    - not: { field: author, op: in, value: [me] }
assign: [competitor-launch]
`;

const when: Condition = {
  all: [
    { field: "category", op: "in", value: ["lead", "release"] },
    {
      any: [
        { field: "title", op: "matches", value: "(?i)v\\d+\\.\\d+: \"quoted\" # not a comment" },
        { not: { field: "author", op: "exists" } },
        { field: "url", op: "is", value: "yes" },
        { field: "language", op: "is", value: "123" },
        { field: "body", op: "contains", value: "null" },
      ],
    },
  ],
};

const rules: [string, Rule][] = [
  [
    "a deterministic Classifier",
    {
      classifier: "launches",
      when: {
        all: [
          { field: "source.type", op: "is", value: "rss" },
          { field: "title", op: "contains", value: "launch" },
        ],
      },
      assign: ["competitor-launch", "2026"],
    },
  ],
  [
    "an Agent-backed Classifier",
    {
      classifier: "sorter",
      prompt: "Sort this:\n\n- a lead\n- a bug report  \n\n  indented: yes # really\n",
      categories: ["lead", "bug-report"],
    },
  ],
  [
    "a deterministic Extractor Rule",
    {
      extractor: "advisory",
      when,
      fields: [
        { name: "cve", type: "string", from: "title", regex: "(CVE-\\d+-\\d+)" },
        { name: "score", type: "integer", from: "body", regex: "score: (\\d+)" },
        { name: "tags", type: "string-array", jsonpath: "$.tags[*].name" },
      ],
    },
  ],
  [
    "an Agent-backed Extractor Rule",
    {
      extractor: "pricing",
      when: { field: "body", op: "matches", value: "\\pL+ " + "x".repeat(200) },
      prompt: "x".repeat(300),
      fields: [
        { name: "plan", type: "string" },
        { name: "price", type: "integer" },
        { name: "features", type: "string-array" },
        { name: "seats", type: "integer-array" },
      ],
    },
  ],
];

describe("the Rule model page's example", () => {
  const { when: condition, ...rest } = deterministicClassifierSchema.parse(ruleFromYaml(example));

  it("parses into the model", () => {
    expect(rest).toEqual({ classifier: "competitor-launch", assign: ["competitor-launch"] });
  });

  it("matches a fitting Item", () => {
    const item = { sourceType: "rss", title: "Acme LAUNCH day", author: "Jane" };
    expect(evaluateCondition(condition, item)).toBe(true);
  });

  it("doesn't match an Item that breaks each part of it", () => {
    const fits = { sourceType: "rss", title: "Introducing Acme", author: "Jane" };
    expect(evaluateCondition(condition, fits)).toBe(true);
    expect(evaluateCondition(condition, { ...fits, sourceType: "github" })).toBe(false);
    expect(evaluateCondition(condition, { ...fits, title: "Acme news" })).toBe(false);
    expect(evaluateCondition(condition, { ...fits, author: "me" })).toBe(false);
  });
});

describe("model → YAML → model", () => {
  it.each(rules)("is deep-equal for %s", (_, rule) => {
    // Every rule here must be a valid one, or the round trip would prove nothing.
    expect(ruleSchema.parse(rule)).toEqual(rule);
    expect(ruleFromYaml(ruleToYaml(rule))).toEqual(rule);
  });

  it("keeps a number a number and a numeric string a string", () => {
    const rule: Rule = {
      extractor: "typed",
      when: { any: [{ field: "url", op: "in", value: [5, "5", 1.5, "true", "~"] }] },
      fields: [{ name: "n", type: "integer", jsonpath: "$.n" }],
    };
    expect(ruleFromYaml(ruleToYaml(rule))).toEqual(rule);
  });

  it("writes no aliases when the model repeats one object", () => {
    const shared = { field: "title", op: "contains", value: "x" } as const;
    const rule: Rule = { classifier: "a", when: { any: [shared, shared] }, assign: ["b"] };
    expect(ruleToYaml(rule)).not.toContain("*");
    expect(ruleFromYaml(ruleToYaml(rule))).toEqual(rule);
  });

  it("keeps a long pattern on one line", () => {
    const value = "x".repeat(200);
    const rule: Rule = { classifier: "a", when: { field: "title", op: "matches", value }, assign: ["b"] };
    expect(ruleToYaml(rule)).toContain(`value: ${value}\n`);
  });
});

describe("ruleFromYaml", () => {
  it("drops comments, because only the model is stored", () => {
    const rule = ruleFromYaml(`# why this exists\n${example}`);
    expect(ruleToYaml(rule)).not.toContain("why this exists");
  });

  it("throws a syntax error with its line for invalid YAML", () => {
    expect(() => ruleFromYaml("classifier: a\n  when: [")).toThrow(/line \d+/);
  });

  it("throws a ZodError that names the field for a rule outside its stage", () => {
    const yaml = "extractor: a\nwhen: { field: severity, op: gte, value: 4 }\nprompt: p\nfields: []\n";
    expect(() => ruleFromYaml(yaml)).toThrow(ZodError);
    expect(() => ruleFromYaml(yaml)).toThrow("can't test");
    expect(() => ruleFromYaml(yaml)).toThrow("severity");
  });

  it("refuses a key the model doesn't have, instead of dropping it", () => {
    expect(() => ruleFromYaml(`${example}\nnotes: keep me\n`)).toThrow("notes");
  });

  it("refuses empty text and text that isn't a rule", () => {
    expect(() => ruleFromYaml("")).toThrow(ZodError);
    expect(() => ruleFromYaml("just a string")).toThrow(ZodError);
  });

  it("refuses two documents in one text", () => {
    expect(() => ruleFromYaml(`${example}\n---\n${example}`)).toThrow();
  });

  it("refuses a duplicate key", () => {
    expect(() => ruleFromYaml(`classifier: a\nclassifier: b\n`)).toThrow();
  });

  it("refuses an alias bomb instead of expanding it", () => {
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
      "classifier: x",
    ].join("\n");
    expect(() => ruleFromYaml(bomb)).toThrow(/alias/i);
  });
});
