import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { type ConditionItem, evaluateActionCondition, evaluateCondition } from "./condition.ts";
import { conditionSchema } from "./schema.ts";

const item: ConditionItem = {
  sourceId: "source-1",
  sourceType: "rss",
  title: "Acme launches Rockets",
  body: "Today we are introducing rockets.",
  author: "Jane",
  url: "https://acme.test/rockets",
  language: "en",
  categories: ["competitor-launch", "release"],
  severity: 2,
  importance: 5,
  fields: { plan: "Pro", price: 49, tags: ["space", "Launch"], seats: [5, 10], nothing: null },
};

const envelope: ConditionItem = {
  sourceId: null,
  sourceType: null,
  title: null,
  body: null,
  author: null,
  url: null,
  language: null,
};

// Conditions go through the schema, as every saved rule does.
const holds = (condition: unknown, on: Partial<ConditionItem> = item) =>
  evaluateCondition(conditionSchema.parse(condition), { ...envelope, ...on });

describe("is", () => {
  it.each([
    ["title", "Acme launches Rockets"],
    ["source", "source-1"],
    ["source.type", "rss"],
    ["language", "en"],
    ["author", "Jane"],
    ["url", "https://acme.test/rockets"],
    ["body", "Today we are introducing rockets."],
    ["severity", 2],
    ["fields.price", 49],
    ["fields.plan", "Pro"],
  ])("%s equals its value", (field, value) => {
    expect(holds({ field, op: "is", value })).toBe(true);
  });

  it("is an exact, case-sensitive match of the same type", () => {
    expect(holds({ field: "author", op: "is", value: "jane" })).toBe(false);
    expect(holds({ field: "severity", op: "is", value: "2" })).toBe(false);
    expect(holds({ field: "fields.price", op: "is", value: 50 })).toBe(false);
  });

  it("holds when any Category equals the value", () => {
    expect(holds({ field: "category", op: "is", value: "release" })).toBe(true);
    expect(holds({ field: "category", op: "is", value: "lead" })).toBe(false);
  });

  it("holds when any value of an array field equals it", () => {
    expect(holds({ field: "fields.seats", op: "is", value: 10 })).toBe(true);
  });
});

describe("in", () => {
  it("holds when the field equals one of the list", () => {
    expect(holds({ field: "author", op: "in", value: ["me", "Jane"] })).toBe(true);
    expect(holds({ field: "author", op: "in", value: ["me"] })).toBe(false);
    expect(holds({ field: "severity", op: "in", value: [1, 2] })).toBe(true);
  });

  it("holds when any Category is on the list", () => {
    expect(holds({ field: "category", op: "in", value: ["lead", "release"] })).toBe(true);
    expect(holds({ field: "category", op: "in", value: ["lead"] })).toBe(false);
  });
});

describe("contains", () => {
  it("is a case-insensitive substring", () => {
    expect(holds({ field: "title", op: "contains", value: "ROCKETS" })).toBe(true);
    expect(holds({ field: "title", op: "contains", value: "boats" })).toBe(false);
  });

  it("folds case outside ASCII", () => {
    expect(holds({ field: "title", op: "contains", value: "ПРИВЕТ" }, { title: "Всем привет" })).toBe(
      true,
    );
  });

  it("looks at each value of an array field", () => {
    expect(holds({ field: "fields.tags", op: "contains", value: "launch" })).toBe(true);
    expect(holds({ field: "category", op: "contains", value: "LAUNCH" })).toBe(true);
  });

  it("fails on a number", () => {
    expect(holds({ field: "fields.price", op: "contains", value: "49" })).toBe(false);
  });
});

describe("matches", () => {
  it("runs the pattern with its inline flag", () => {
    expect(holds({ field: "title", op: "matches", value: "(?i)launch|introducing" })).toBe(true);
    expect(holds({ field: "title", op: "matches", value: "^launch" })).toBe(false);
  });

  it("fails on a number", () => {
    expect(holds({ field: "fields.price", op: "matches", value: "49" })).toBe(false);
  });

  // The limit is a vm timeout for the reason given in regex.test.ts.
  it("finishes (a+)+$ on 32 KB of a's and a b", () => {
    const body = `${"a".repeat(32 * 1024)}b`;
    const match = () => holds({ field: "body", op: "matches", value: "(a+)+$" }, { body });
    expect(runInNewContext("match()", { match }, { timeout: 30_000 })).toBe(false);
  });
});

describe("gte and lte", () => {
  it("compare numbers, inclusive of the bound", () => {
    expect(holds({ field: "importance", op: "gte", value: 5 })).toBe(true);
    expect(holds({ field: "importance", op: "gte", value: 6 })).toBe(false);
    expect(holds({ field: "severity", op: "lte", value: 2 })).toBe(true);
    expect(holds({ field: "severity", op: "lte", value: 1 })).toBe(false);
  });

  it("fail on a non-number, even one that looks numeric", () => {
    expect(holds({ field: "title", op: "gte", value: 0 })).toBe(false);
    expect(holds({ field: "fields.plan", op: "lte", value: 100 })).toBe(false);
    expect(holds({ field: "fields.n", op: "gte", value: 1 }, { fields: { n: "5" } })).toBe(false);
  });
});

describe("exists", () => {
  it("holds when the field is present", () => {
    expect(holds({ field: "author", op: "exists" })).toBe(true);
    expect(holds({ field: "fields.plan", op: "exists" })).toBe(true);
    expect(holds({ field: "category", op: "exists" })).toBe(true);
  });

  it("holds for an empty string, which is a value", () => {
    expect(holds({ field: "body", op: "exists" }, { body: "" })).toBe(true);
  });

  it("fails for null, no Categories, a stage's absent keys and an empty array", () => {
    expect(holds({ field: "author", op: "exists" }, { author: null })).toBe(false);
    expect(holds({ field: "severity", op: "exists" }, {})).toBe(false);
    expect(holds({ field: "category", op: "exists" }, {})).toBe(false);
    expect(holds({ field: "category", op: "exists" }, { categories: [] })).toBe(false);
    expect(holds({ field: "fields.x", op: "exists" }, { fields: { x: [] } })).toBe(false);
    expect(holds({ field: "fields.nothing", op: "exists" })).toBe(false);
  });

  it("doesn't find names an object inherits", () => {
    expect(holds({ field: "fields.constructor", op: "exists" }, { fields: {} })).toBe(false);
    expect(holds({ field: "fields.toString", op: "exists" }, { fields: {} })).toBe(false);
  });
});

describe("a missing field", () => {
  it.each([
    { field: "author", op: "is", value: "x" },
    { field: "author", op: "in", value: ["x"] },
    { field: "author", op: "contains", value: "x" },
    { field: "author", op: "matches", value: "" },
    { field: "severity", op: "gte", value: 0 },
    { field: "severity", op: "lte", value: 100 },
    { field: "author", op: "exists" },
    { field: "category", op: "is", value: "x" },
    { field: "fields.x", op: "is", value: "x" },
  ])("fails $field $op, and holds inside not", (predicate) => {
    expect(holds(predicate, {})).toBe(false);
    expect(holds({ not: predicate }, {})).toBe(true);
  });
});

// An Action Condition on an Item that finished the pipeline unrated (docs: Processing pipeline,
// "The Act stage").
describe("an Action Condition on an unrated Item", () => {
  const unrated: Partial<ConditionItem> = { ...item, severity: null, importance: null };
  const acts = (condition: unknown, on: Partial<ConditionItem> = unrated) =>
    evaluateActionCondition(conditionSchema.parse(condition), { ...envelope, ...on });

  it("doesn't hold when the Condition tests the Rating, inside not too", () => {
    expect(acts({ not: { field: "severity", op: "gte", value: 4 } })).toBe(false);
    expect(acts({ field: "severity", op: "gte", value: 4 })).toBe(false);
    expect(acts({ field: "importance", op: "lte", value: 5 })).toBe(false);
  });

  it("doesn't hold when a Rating test sits anywhere in the tree", () => {
    const advisory = { field: "category", op: "is", value: "release" };
    expect(acts({ any: [advisory, { field: "importance", op: "gte", value: 1 }] })).toBe(false);
    expect(acts({ all: [advisory, { not: { field: "severity", op: "exists" } }] })).toBe(false);
  });

  it("holds when a Condition without a Rating field does, so an advisory still alerts", () => {
    expect(acts({ field: "category", op: "is", value: "release" })).toBe(true);
    expect(acts({ all: [{ field: "fields.plan", op: "is", value: "Pro" }] })).toBe(true);
    expect(acts({ field: "category", op: "is", value: "lead" })).toBe(false);
  });

  it("evaluates a rated Item as usual, a corrected Rating included", () => {
    expect(acts({ not: { field: "severity", op: "gte", value: 4 } }, item)).toBe(true);
    expect(acts({ field: "importance", op: "gte", value: 5 }, item)).toBe(true);
    expect(acts({ field: "importance", op: "gte", value: 5 }, { ...item, severity: 3 })).toBe(true);
  });
});

describe("nesting", () => {
  const yes = { field: "author", op: "is", value: "Jane" };
  const no = { field: "author", op: "is", value: "Joe" };

  it("all holds when every child does", () => {
    expect(holds({ all: [yes, yes] })).toBe(true);
    expect(holds({ all: [yes, no] })).toBe(false);
  });

  it("any holds when one child does", () => {
    expect(holds({ any: [no, yes] })).toBe(true);
    expect(holds({ any: [no, no] })).toBe(false);
  });

  it("not inverts its child", () => {
    expect(holds({ not: no })).toBe(true);
    expect(holds({ not: yes })).toBe(false);
  });

  it("evaluates a deep tree", () => {
    expect(holds({ all: [yes, { any: [no, { not: { all: [yes, no] } }] }] })).toBe(true);
    expect(holds({ all: [yes, { any: [no, { not: { any: [yes, no] } }] }] })).toBe(false);
  });
});
