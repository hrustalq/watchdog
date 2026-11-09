import { draftToYaml } from "@watchdog/core/rules/draft";
import { describe, expect, it } from "vitest";
import {
  addPart,
  blankRule,
  changeField,
  changeKind,
  changeOp,
  conditionPart,
  destinationFits,
  fieldPart,
  fieldReading,
  formHides,
  formShows,
  fromLines,
  inActionOrder,
  isNumericField,
  kindOf,
  negate,
  readDraft,
  removeAt,
  ruleTypeOf,
  setAt,
  typedValue,
} from "./rule-draft.ts";

function read(text: string) {
  const result = readDraft(text);
  if ("error" in result) throw new Error(result.error);
  return result.draft;
}

describe("switching between the Form and YAML views", () => {
  it("shows an edit made in the form in the YAML, and one made in the YAML in the form", () => {
    const edited = setAt(setAt(blankRule("classifier", "deterministic"), ["classifier"], "launches"), ["when", "value"], "launch");

    const yaml = draftToYaml(edited);
    expect(yaml).toContain("classifier: launches");
    expect(yaml).toContain("value: launch");

    expect(read(yaml.replace("value: launch", "value: release"))).toMatchObject({ when: { value: "release" } });
  });

  it("keeps a half-typed regex and a value that isn't a number yet", () => {
    const draft = { extractor: "x", when: { field: "title", op: "gte", value: "abc" }, fields: [{ name: "n", type: "string", from: "title", regex: "(CVE" }] };
    expect(read(draftToYaml(draft))).toEqual(draft);
  });

  it("keeps what the form has no control for", () => {
    const draft = read('classifier: x\nnote: "keep me"\nwhen: { field: title, op: weird, value: { nested: true } }\nassign: [a]\n');
    const edited = setAt(draft, ["classifier"], "y");
    expect(read(draftToYaml(edited))).toEqual({
      classifier: "y",
      note: "keep me",
      when: { field: "title", op: "weird", value: { nested: true } },
      assign: ["a"],
    });
  });

  it.each([
    ["text it can't parse", "classifier: [", "Flow sequence"],
    ["text that isn't a mapping", "- one\n- two\n", "starts with"],
    ["a mapping that names no rule", "name: x\n", "starts with"],
    ["nothing at all", "", "starts with"],
    ["an alias that contains itself", "classifier: x\nwhen: &a { not: *a }\n", "contains itself"],
  ])("stays in YAML on %s", (_, text, message) => {
    const result = readDraft(text);
    expect("error" in result && result.error).toContain(message);
  });
});

describe("the blank rules", () => {
  it.each([
    ["classifier", "deterministic"],
    ["classifier", "agent"],
    ["extractor", "deterministic"],
    ["extractor", "agent"],
  ] as const)("start a %s %s with what the form shows", (type, kind) => {
    const draft = blankRule(type, kind);
    expect(ruleTypeOf(draft)).toBe(type);
    expect(kindOf(draft)).toBe(kind);
    expect(formHides(draft)).toEqual([]);
  });
});

describe("kindOf", () => {
  it("reads the kind from the prompt, as the schemas do", () => {
    expect(kindOf({ classifier: "x", prompt: "" })).toBe("agent");
    expect(kindOf({ classifier: "x", when: {} })).toBe("deterministic");
  });

  it("doesn't call an Action Agent-backed for a prompt the schema will refuse", () => {
    expect(kindOf({ action: "x", prompt: "" })).toBe("deterministic");
  });
});

describe("an Action's draft", () => {
  it("starts blank as an alert with what the form shows", () => {
    const draft = blankRule("action");
    expect(ruleTypeOf(draft)).toBe("action");
    expect(draft).toMatchObject({ kind: "alert", destinations: [] });
    expect(formHides(draft)).toEqual([]);
  });

  it("is read from YAML like the other rules", () => {
    expect(ruleTypeOf(read("action: x\nkind: alert\n"))).toBe("action");
    const result = readDraft("name: x\n");
    expect("error" in result && result.error).toContain('"action:"');
  });

  it("gains a blank schedule in the model's order when it becomes a Digest", () => {
    const digest = changeKind({ ...blankRule("action"), action: "x" }, "digest");
    expect(Object.keys(digest)).toEqual(["action", "when", "kind", "schedule", "destinations"]);
    expect(digest).toMatchObject({ kind: "digest", schedule: "" });
    expect(formHides(digest)).toEqual([]);
  });

  it("keeps a schedule it has and every other value when its kind changes", () => {
    const digest = { action: "x", kind: "alert", schedule: "0 9 * * 1", destinations: ["me"], note: "kept" };
    expect(changeKind(digest, "digest")).toEqual({ ...digest, kind: "digest" });
  });

  it("loses its schedule when it stops being a Digest, which the schema would refuse", () => {
    const digest = { action: "x", kind: "digest", schedule: "0 9 * * 1", destinations: ["me"] };
    expect(changeKind(digest, "webhook")).toEqual({ action: "x", kind: "webhook", destinations: ["me"] });
  });

  it("names what the form has no control for", () => {
    const base = { action: "x", when: {}, kind: "alert", destinations: [] };
    expect(formHides({ ...base, note: "hi" })).toEqual(["note"]);
    expect(formHides({ ...base, schedule: "0 9 * * 1" })).toEqual(["schedule"]);
    expect(formHides({ ...base, destinations: "me" })).toEqual(["destinations"]);
    expect(formHides({ ...base, kind: "digest", schedule: ["a"] })).toEqual(["schedule"]);
  });

  it("puts its keys in the model's order, and only the ones it has", () => {
    const draft = { destinations: [], note: "hi", kind: "alert", action: "x" };
    expect(Object.keys(inActionOrder(draft))).toEqual(["action", "kind", "destinations", "note"]);
  });
});

describe("destinationFits", () => {
  it.each([
    ["webhook", "webhook", true],
    ["webhook", "email", false],
    ["webhook", "telegram", false],
    ["alert", "webhook", false],
    ["alert", "email", true],
    ["alert", "telegram", true],
    ["digest", "webhook", false],
    ["digest", "email", true],
  ] as const)("on a %s Action, a %s Destination: %s", (kind, type, fits) => {
    expect(destinationFits(kind, type)).toBe(fits);
  });
});

describe("isNumericField", () => {
  const declared = [
    { name: "price", type: "integer" },
    { name: "ports", type: "integer-array" },
    { name: "plan", type: "string" },
  ];

  it.each([
    ["severity", true],
    ["importance", true],
    ["fields.price", true],
    ["fields.ports", true],
    ["fields.plan", false],
    ["fields.unknown", false],
    ["title", false],
    [undefined, false],
  ])("%s: %s", (field, numeric) => {
    expect(isNumericField(field, declared)).toBe(numeric);
  });
});

describe("changeField", () => {
  it("moves a text test to a number test on a number field, keeping a value that is a number", () => {
    expect(changeField({ field: "title", op: "contains", value: "4" }, "severity", true)).toEqual({
      field: "severity",
      op: "gte",
      value: 4,
    });
  });

  it("makes a number of what an is holds, because \"4\" never equals 4", () => {
    expect(changeField({ field: "title", op: "is", value: "4" }, "importance", true)).toEqual({
      field: "importance",
      op: "is",
      value: 4,
    });
    expect(changeField({ field: "title", op: "in", value: ["4", "x"] }, "severity", true)).toEqual({
      field: "severity",
      op: "in",
      value: [4, "x"],
    });
  });

  it("moves a number test to a text test on a text field, as text", () => {
    expect(changeField({ field: "severity", op: "gte", value: 4 }, "title", false)).toEqual({
      field: "title",
      op: "contains",
      value: "4",
    });
    expect(changeField({ field: "severity", op: "is", value: 4 }, "title", false)).toEqual({
      field: "title",
      op: "is",
      value: "4",
    });
  });

  it("adds no value to a test that takes none", () => {
    expect(changeField({ field: "title", op: "exists" }, "severity", true)).toEqual({ field: "severity", op: "exists" });
  });
});

describe("setAt and removeAt", () => {
  it("doesn't change the draft it was given", () => {
    const draft = { fields: [{ name: "a" }, { name: "b" }] };
    expect(setAt(draft, ["fields", 1, "name"], "c")).toEqual({ fields: [{ name: "a" }, { name: "c" }] });
    expect(removeAt(draft, ["fields", 0])).toEqual({ fields: [{ name: "b" }] });
    expect(draft).toEqual({ fields: [{ name: "a" }, { name: "b" }] });
  });

  it("removes a key", () => {
    expect(removeAt({ field: "title", op: "exists", value: "x" }, ["value"])).toEqual({ field: "title", op: "exists" });
  });
});

describe("conditionPart", () => {
  it.each([
    [{ all: [] }, "all"],
    [{ any: [] }, "any"],
    [{ not: {} }, "not"],
    [{ field: "title", op: "contains", value: "x" }, "predicate"],
    [{ field: "title", op: "exists" }, "predicate"],
    [{ field: "title", op: "in", value: ["a", 1] }, "predicate"],
    [{ field: "severity", op: "weird", value: 1 }, "predicate"],
  ])("shows %j as %s", (node, part) => {
    expect(conditionPart(node)).toBe(part);
  });

  it.each([
    [undefined],
    ["text"],
    [{ all: "x" }],
    [{ all: [], any: [] }],
    [{ all: [], extra: 1 }],
    [{ field: "title", op: "is", value: { a: 1 } }],
    [{ field: "title", op: "is", value: "x", extra: 1 }],
    [{ field: 1, op: "is", value: "x" }],
    [{ field: "title", op: "in", value: [{ a: 1 }] }],
  ])("leaves %j to the YAML view", (node) => {
    expect(conditionPart(node)).toBe("yaml-only");
  });

  it("leaves a Condition too big to render to the YAML view", () => {
    const big = { all: Array.from({ length: 300 }, () => ({ field: "title", op: "exists" })) };
    expect(conditionPart(big)).toBe("yaml-only");
  });
});

describe("conditionPart on a huge list", () => {
  it("leaves it to the YAML view rather than overflowing the arguments of a call", () => {
    const huge = { all: Array.from({ length: 200_000 }, () => ({ field: "title", op: "exists" })) };
    expect(conditionPart(huge)).toBe("yaml-only");
  });
});

describe("fieldPart", () => {
  it.each([
    [{ name: "a", type: "string", from: "title", regex: "(x)" }, "deterministic", "regex"],
    [{ name: "a", type: "string", jsonpath: "$.x" }, "deterministic", "jsonpath"],
    [{ name: "a", type: "string", css: ".price" }, "deterministic", "css"],
    [{ name: "a", type: "string-array", css: "a", attr: "href" }, "deterministic", "css"],
    [{ name: "a", type: "string" }, "deterministic", "regex"],
    [{ name: "a", type: "string" }, "agent", "agent"],
  ] as const)("shows %j on a %s rule as %s", (field, kind, part) => {
    expect(fieldPart(field, kind)).toBe(part);
  });

  it.each([
    [{ name: "a", regex: "(x)", jsonpath: "$" }, "deterministic"],
    [{ name: "a", jsonpath: "$", css: "a" }, "deterministic"],
    [{ name: "a", type: "string", css: "a", from: "title" }, "deterministic"],
    [{ name: "a", type: "string", extra: 1 }, "deterministic"],
    [{ name: "a", regex: "(x)" }, "agent"],
    [{ name: { a: 1 } }, "agent"],
    ["text", "deterministic"],
  ] as const)("leaves %j on a %s rule to the YAML view", (field, kind) => {
    expect(fieldPart(field, kind)).toBe("yaml-only");
  });
});

describe("fieldReading", () => {
  it("keeps a field's name and type when it switches to a CSS selector", () => {
    expect(fieldReading({ name: "plans", type: "string-array", jsonpath: "$.x" }, "css")).toEqual({
      name: "plans",
      type: "string-array",
      css: "",
    });
  });

  it("keeps an array type for JSONPath and drops it for a regex", () => {
    const css = { name: "plans", type: "string-array", css: "h3", attr: "title" };
    expect(fieldReading(css, "jsonpath")).toEqual({ name: "plans", type: "string-array", jsonpath: "" });
    expect(fieldReading(css, "regex")).toEqual({ name: "plans", type: "string", from: "title", regex: "" });
  });
});

describe("addPart and negate", () => {
  const test = { field: "title", op: "contains", value: "x" };

  it("adds a test beside a lone predicate by grouping them", () => {
    expect(addPart(test)).toEqual({ all: [test, { field: "title", op: "contains", value: "" }] });
  });

  it("adds a test to a group", () => {
    expect(addPart({ any: [test] })).toEqual({ any: [test, { field: "title", op: "contains", value: "" }] });
  });

  it("negates a part, and undoes a negation", () => {
    expect(negate(test)).toEqual({ not: test });
    expect(negate({ not: test })).toEqual(test);
  });
});

describe("changeOp", () => {
  const predicate = (op: string, value?: unknown) => ({ field: "title", op, ...(value === undefined ? {} : { value }) });

  it("keeps the value where the new operator can hold it", () => {
    expect(changeOp(predicate("contains", "x"), "matches")).toEqual(predicate("matches", "x"));
    expect(changeOp(predicate("is", "x"), "in")).toEqual(predicate("in", ["x"]));
    expect(changeOp(predicate("in", ["x", "y"]), "is")).toEqual(predicate("is", "x"));
  });

  it("drops the value for exists and starts one when leaving it", () => {
    expect(changeOp(predicate("is", "x"), "exists")).toEqual(predicate("exists"));
    expect(changeOp(predicate("exists"), "contains")).toEqual(predicate("contains", ""));
    expect(changeOp(predicate("exists"), "in")).toEqual(predicate("in", []));
  });

  it("starts an empty list from a value with nothing typed, so it can't pass as an entry", () => {
    expect(changeOp(predicate("contains", ""), "in")).toEqual(predicate("in", []));
  });

  it("makes text of a number for the operators that take only text", () => {
    expect(changeOp(predicate("is", 2024), "contains")).toEqual(predicate("contains", "2024"));
    expect(changeOp(predicate("in", [2024]), "matches")).toEqual(predicate("matches", "2024"));
  });

  it("keeps a number for the operators that can hold one", () => {
    expect(changeOp(predicate("is", 2024), "gte")).toEqual(predicate("gte", 2024));
  });
});

describe("typedValue", () => {
  it("makes a number of a number, and keeps anything else as typed for gte and lte", () => {
    expect(typedValue("gte", "x", "4")).toBe(4);
    expect(typedValue("lte", 4, "-1.5")).toBe(-1.5);
    expect(typedValue("gte", 4, "4a")).toBe("4a");
  });

  it("keeps text as text for is, unless the value was already a number", () => {
    expect(typedValue("is", "x", "4")).toBe("4");
    expect(typedValue("is", 4, "5")).toBe(5);
    expect(typedValue("is", 4, "five")).toBe("five");
  });

  it("keeps text as text for contains and matches, whatever it was", () => {
    expect(typedValue("contains", 4, "2025")).toBe("2025");
    expect(typedValue("matches", "x", "2025")).toBe("2025");
  });

  it("makes a number for is on a number field, because \"4\" never equals 4", () => {
    expect(typedValue("is", "", "4", true)).toBe(4);
    expect(typedValue("is", "", "four", true)).toBe("four");
    expect(typedValue("contains", "", "4", true)).toBe("4");
  });
});

describe("fromLines", () => {
  it("keeps a trailing blank line while the user is typing, and drops blanks when told to", () => {
    expect(fromLines("a\nb\n")).toEqual(["a", "b", ""]);
    expect(fromLines("a\n\n b \n", { tidy: true })).toEqual(["a", "b"]);
    expect(fromLines("")).toEqual([]);
  });
});

describe("formHides", () => {
  it("names the keys the form has no control for", () => {
    expect(formHides({ classifier: "x", when: {}, assign: [], note: 1 })).toEqual(["note"]);
    expect(formHides({ classifier: "x", prompt: "p", categories: [], when: {} })).toEqual(["when"]);
    expect(formHides({ extractor: "x", when: {}, fields: "text" })).toEqual(["fields"]);
    expect(formHides({ classifier: { a: 1 }, when: {}, assign: [{ a: 1 }] })).toEqual(["classifier", "assign"]);
  });
});

describe("formShows", () => {
  it.each([
    "classifier",
    "extractor",
    "prompt",
    "assign",
    "assign.0",
    "categories.1",
    "fields",
    "fields.0",
    "fields.2.regex",
    "fields.0.css",
    "fields.0.attr",
    "when",
    "when.field",
    "when.value",
    "when.value.0",
    "when.all",
    "when.all.1.value",
    "when.all.1.not.any.0.op",
    "action",
    "kind",
    "schedule",
    "destinations",
    "destinations.1",
  ])("has a place for a problem at %s", (path) => {
    expect(formShows(path)).toBe(true);
  });

  it.each(["", "note", "assign.0.x", "fields.0.note", "when.note"])("leaves a problem at %j to the summary", (path) => {
    expect(formShows(path)).toBe(false);
  });
});
