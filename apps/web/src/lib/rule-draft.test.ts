import { draftToYaml } from "@watchdog/core/rules/draft";
import { describe, expect, it } from "vitest";
import {
  addPart,
  blankRule,
  changeOp,
  conditionPart,
  fieldPart,
  formHides,
  formShows,
  fromLines,
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

describe("fieldPart", () => {
  it.each([
    [{ name: "a", type: "string", from: "title", regex: "(x)" }, "deterministic", "regex"],
    [{ name: "a", type: "string", jsonpath: "$.x" }, "deterministic", "jsonpath"],
    [{ name: "a", type: "string" }, "deterministic", "regex"],
    [{ name: "a", type: "string" }, "agent", "agent"],
  ] as const)("shows %j on a %s rule as %s", (field, kind, part) => {
    expect(fieldPart(field, kind)).toBe(part);
  });

  it.each([
    [{ name: "a", regex: "(x)", jsonpath: "$" }, "deterministic"],
    [{ name: "a", type: "string", extra: 1 }, "deterministic"],
    [{ name: "a", regex: "(x)" }, "agent"],
    [{ name: { a: 1 } }, "agent"],
    ["text", "deterministic"],
  ] as const)("leaves %j on a %s rule to the YAML view", (field, kind) => {
    expect(fieldPart(field, kind)).toBe("yaml-only");
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
    "when",
    "when.field",
    "when.value",
    "when.value.0",
    "when.all",
    "when.all.1.value",
    "when.all.1.not.any.0.op",
  ])("has a place for a problem at %s", (path) => {
    expect(formShows(path)).toBe(true);
  });

  it.each(["", "note", "assign.0.x", "fields.0.note", "when.note"])("leaves a problem at %j to the summary", (path) => {
    expect(formShows(path)).toBe(false);
  });
});
