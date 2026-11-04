import { describe, expect, it } from "vitest";
import {
  agentClassifierSchema,
  agentExtractorRuleSchema,
  conditionSchema,
  deterministicClassifierSchema,
  deterministicExtractorRuleSchema,
  ruleSchema,
} from "./schema.ts";

const title = { field: "title", op: "contains", value: "launch" };

function issuesOf(result: { error?: { issues: { message: string; path: PropertyKey[] }[] } }) {
  return (result.error?.issues ?? []).map(({ message, path }) => ({ message, path }));
}

describe("conditionSchema", () => {
  it.each([
    { field: "title", op: "is", value: "x" },
    { field: "severity", op: "is", value: 5 },
    { field: "author", op: "in", value: ["me", "you"] },
    { field: "body", op: "contains", value: "x" },
    { field: "title", op: "matches", value: "(?i)x" },
    { field: "importance", op: "gte", value: 3 },
    { field: "fields.price", op: "lte", value: 9.5 },
    { field: "url", op: "exists" },
    { field: "source", op: "is", value: "5f0e" },
    { field: "source.type", op: "is", value: "rss" },
    { field: "language", op: "is", value: "en" },
    { field: "category", op: "is", value: "lead" },
  ])("accepts $field $op", (predicate) => {
    expect(conditionSchema.parse(predicate)).toEqual(predicate);
  });

  it("accepts a nested tree", () => {
    const tree = { all: [title, { any: [title, { not: title }] }] };
    expect(conditionSchema.parse(tree)).toEqual(tree);
  });

  it.each([
    ["an unknown field", { field: "nope", op: "is", value: "x" }, "nope"],
    ["an empty extracted field name", { field: "fields.", op: "exists" }, "fields."],
    ["an unknown operator", { field: "title", op: "like", value: "x" }, "operator"],
    ["a number for contains", { field: "title", op: "contains", value: 1 }, "string"],
    ["a string for gte", { field: "severity", op: "gte", value: "4" }, "number"],
    ["a scalar for in", { field: "title", op: "in", value: "x" }, "array"],
    ["an empty list for in", { field: "title", op: "in", value: [] }, ">=1"],
    ["a value on exists", { field: "title", op: "exists", value: true }, "value"],
    ["an empty all", { all: [] }, ">=1"],
    ["an empty any", { any: [] }, ">=1"],
    ["a key beside all", { all: [title], any: [title] }, "any"],
    ["a broken regex", { field: "title", op: "matches", value: "(" }, '"("'],
    ["a regex over the cap", { field: "title", op: "matches", value: "a{1,1000}" }, "too complex"],
  ])("refuses %s, saying so", (_, condition, expected) => {
    const { message } = issuesOf(conditionSchema.safeParse(condition))[0] ?? { message: "" };
    expect(message).toContain(expected);
  });

  it("points the error at the exact node inside the tree", () => {
    const tree = { all: [title, { not: { any: [{ field: "title", op: "gte", value: "x" }] } }] };
    expect(issuesOf(conditionSchema.safeParse(tree))[0]?.path).toEqual([
      "all",
      1,
      "not",
      "any",
      0,
      "value",
    ]);
  });

  it("refuses the 20-branch alternation from ADR 0026", () => {
    const value = Array(20).fill("a{1,1000}").join("|");
    const result = conditionSchema.safeParse({ field: "title", op: "matches", value });
    expect(issuesOf(result)[0]?.message).toContain("too complex");
  });
});

describe("deterministicClassifierSchema", () => {
  const classifier = { classifier: "launches", when: title, assign: ["competitor-launch"] };

  it("accepts when and assign", () => {
    expect(deterministicClassifierSchema.parse(classifier)).toEqual(classifier);
  });

  it.each(["category", "severity", "importance", "fields.price"])(
    "refuses %s in when, naming the field",
    (field) => {
      const when = { all: [title, { not: { field, op: "exists" } }] };
      const issue = issuesOf(deterministicClassifierSchema.safeParse({ ...classifier, when }))[0];
      expect(issue?.message).toContain(`"${field}"`);
      expect(issue?.path).toEqual(["when", "all", 1, "not", "field"]);
    },
  );

  it.each(["source", "source.type", "title", "body", "author", "url", "language"])(
    "accepts %s in when",
    (field) => {
      const when = { field, op: "exists" };
      expect(deterministicClassifierSchema.safeParse({ ...classifier, when }).success).toBe(true);
    },
  );

  it("refuses an empty assign and a key it doesn't know", () => {
    expect(deterministicClassifierSchema.safeParse({ ...classifier, assign: [] }).success).toBe(
      false,
    );
    expect(deterministicClassifierSchema.safeParse({ ...classifier, whne: 1 }).success).toBe(false);
  });
});

describe("agentClassifierSchema", () => {
  const classifier = { classifier: "sorter", prompt: "Sort it.", categories: ["lead", "bug"] };

  it("accepts a prompt and the Categories it may assign", () => {
    expect(agentClassifierSchema.parse(classifier)).toEqual(classifier);
  });

  it("refuses an empty prompt and no Categories", () => {
    expect(agentClassifierSchema.safeParse({ ...classifier, prompt: "" }).success).toBe(false);
    expect(agentClassifierSchema.safeParse({ ...classifier, categories: [] }).success).toBe(false);
  });
});

describe("deterministicExtractorRuleSchema", () => {
  const rule = {
    extractor: "advisory",
    when: { field: "category", op: "is", value: "security-advisory" },
    fields: [
      { name: "cve", type: "string", from: "title", regex: "(CVE-\\d+-\\d+)" },
      { name: "score", type: "integer", from: "body", regex: "score (\\d+)" },
      { name: "tags", type: "string-array", jsonpath: "$.tags[*].name" },
    ],
  };

  it("accepts regex fields on title or body and JSONPath fields", () => {
    expect(deterministicExtractorRuleSchema.parse(rule)).toEqual(rule);
  });

  it.each(["severity", "importance", "fields.cve"])(
    "refuses %s in its Condition, naming the field",
    (field) => {
      const when = { field, op: "exists" };
      const issue = issuesOf(deterministicExtractorRuleSchema.safeParse({ ...rule, when }))[0];
      expect(issue?.message).toContain(`"${field}"`);
      expect(issue?.path).toEqual(["when", "field"]);
    },
  );

  it.each(["category", "source", "source.type", "title", "body", "author", "url", "language"])(
    "accepts %s in its Condition",
    (field) => {
      const when = { field, op: "exists" };
      expect(deterministicExtractorRuleSchema.safeParse({ ...rule, when }).success).toBe(true);
    },
  );

  it.each([
    ["a regex on another field", { name: "x", type: "string", from: "url", regex: "(x)" }, "from"],
    ["a regex that doesn't compile", { name: "x", type: "string", from: "body", regex: "(" }, '"("'],
    [
      "a regex over the cap",
      { name: "x", type: "string", from: "body", regex: "(a{1,1000})" },
      "too complex",
    ],
    [
      "a regex with no capture group",
      { name: "x", type: "string", from: "body", regex: "x" },
      "capture group",
    ],
    [
      "an array from one capture group",
      { name: "x", type: "string-array", from: "body", regex: "(x)" },
      "type",
    ],
    ["a JSONPath without a root", { name: "x", type: "string", jsonpath: "tags" }, "$"],
    ["a type it doesn't know", { name: "x", type: "date", jsonpath: "$.a" }, "type"],
    ["a field that says neither", { name: "x", type: "string" }, "regex or jsonpath"],
    ["a field that says both", { name: "x", type: "string", from: "body", regex: "(x)", jsonpath: "$" }, "regex or jsonpath"],
    ["a name with a dot", { name: "a.b", type: "string", jsonpath: "$.a" }, "name"],
  ])("refuses %s", (_, field, expected) => {
    const issue = issuesOf(deterministicExtractorRuleSchema.safeParse({ ...rule, fields: [field] }))[0];
    expect(`${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`).toContain(expected);
  });

  it("refuses two fields with one name, pointing at the second", () => {
    const fields = [
      { name: "x", type: "string", jsonpath: "$.a" },
      { name: "x", type: "string", jsonpath: "$.b" },
    ];
    const issue = issuesOf(deterministicExtractorRuleSchema.safeParse({ ...rule, fields }))[0];
    expect(issue?.message).toContain('"x"');
    expect(issue?.path).toEqual(["fields", 1, "name"]);
  });

  it("refuses a rule with no fields", () => {
    expect(deterministicExtractorRuleSchema.safeParse({ ...rule, fields: [] }).success).toBe(false);
  });
});

describe("agentExtractorRuleSchema", () => {
  const rule = {
    extractor: "pricing",
    when: { field: "category", op: "is", value: "competitor-launch" },
    prompt: "Pull out the pricing.",
    fields: [
      { name: "plan", type: "string" },
      { name: "price", type: "integer" },
      { name: "features", type: "string-array" },
      { name: "seats", type: "integer-array" },
    ],
  };

  it("accepts a Condition, a prompt and fields of every declared type", () => {
    expect(agentExtractorRuleSchema.parse(rule)).toEqual(rule);
  });

  it("refuses severity in its Condition, naming the field", () => {
    const when = { field: "severity", op: "gte", value: 4 };
    expect(issuesOf(agentExtractorRuleSchema.safeParse({ ...rule, when }))[0]?.message).toContain(
      '"severity"',
    );
  });

  it("refuses a field that says where to read from, because the Agent decides", () => {
    const fields = [{ name: "x", type: "string", jsonpath: "$.a" }];
    expect(agentExtractorRuleSchema.safeParse({ ...rule, fields }).success).toBe(false);
  });
});

describe("ruleSchema", () => {
  const when = { field: "title", op: "exists" };

  it.each([
    { classifier: "a", when, assign: ["x"] },
    { classifier: "a", prompt: "p", categories: ["x"] },
    { extractor: "a", when, fields: [{ name: "n", type: "string", jsonpath: "$.a" }] },
    { extractor: "a", when, prompt: "p", fields: [{ name: "n", type: "string" }] },
  ])("accepts every rule kind", (rule) => {
    expect(ruleSchema.parse(rule)).toEqual(rule);
  });

  it("keeps the stage's message when it picks the rule's kind itself", () => {
    const rule = { extractor: "a", when: { field: "severity", op: "exists" }, prompt: "p", fields: [] };
    expect(issuesOf(ruleSchema.safeParse(rule)).map((issue) => issue.message).join()).toContain(
      '"severity"',
    );
  });

  it("refuses something that is neither a Classifier nor an Extractor Rule", () => {
    expect(issuesOf(ruleSchema.safeParse({ when }))[0]?.message).toContain("classifier");
    expect(issuesOf(ruleSchema.safeParse("text"))[0]?.message).toContain("classifier");
    expect(issuesOf(ruleSchema.safeParse(null))[0]?.message).toContain("classifier");
  });
});
