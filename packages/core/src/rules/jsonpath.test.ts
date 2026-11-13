import { describe, expect, it } from "vitest";
import { jsonPathError, jsonPathFansOut, jsonPathNodeCount, jsonPathValues } from "./jsonpath.ts";

describe("jsonPathValues", () => {
  const raw = {
    title: { value: "A release" },
    categories: [{ name: "Releases" }, { name: "Security", rank: 2 }],
  };

  it.each([
    ["$.title.value", ["A release"]],
    ["$.categories[*].name", ["Releases", "Security"]],
    ["$.categories[?@.rank == 2].name", ["Security"]],
    ["$..rank", [2]],
    ["$.nothing.here", []],
  ])("reads %s", (path, expected) => {
    expect(jsonPathValues(path, raw)).toEqual(expected);
  });

  it("doesn't reach an object's prototype", () => {
    expect(jsonPathValues("$.constructor", {})).toEqual([]);
    expect(jsonPathValues("$.__proto__", {})).toEqual([]);
  });

  it("compares a filter's string with the data, never running it", () => {
    const code = "globalThis.ranFromJsonPath = true";
    expect(jsonPathValues(`$[?@.a == '${code}'].a`, [{ a: code }, { a: "other" }])).toEqual([code]);
    expect(globalThis).not.toHaveProperty("ranFromJsonPath");
  });

  it("stops one value past the most a field can hold, however many a path multiplies into", () => {
    const wide = { a: Array.from({ length: 3000 }, () => ({ b: [1, 2, 3] })) };
    expect(jsonPathValues("$..[*,*]", wide)).toHaveLength(1001);
  });

  it("gives no values, rather than throwing, for raw nested too deeply to walk", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 500; i++) deep = [deep];
    expect(jsonPathValues("$..*", deep)).toBeUndefined();
  });
});

describe("jsonPathError", () => {
  it.each(["$", "$.a.b", "$.tags[*].name", "$[?@.a > 1 && @.b == 'x'].c", "$.a[0,1,2]", "$..a"])(
    "accepts %s",
    (path) => {
      expect(jsonPathError(path)).toBeUndefined();
    },
  );

  // A filter in a library such as jsonpath-plus can reach these. Here each one has to fail to parse,
  // so a rule holding it can't be saved or run.
  it.each([
    "$[?(@.constructor.constructor('globalThis.ranFromJsonPath = true')())]",
    "$[?@.a == process.exit(1)]",
    "$[?(globalThis.ranFromJsonPath = true)]",
    "$[?eval('globalThis.ranFromJsonPath = true')]",
    "$[?(function () { globalThis.ranFromJsonPath = true })()]",
    "$[?require('node:fs')]",
  ])("refuses code in a filter: %s", (path) => {
    expect(jsonPathError(path)).toContain("isn't a JSONPath");
    expect(globalThis).not.toHaveProperty("ranFromJsonPath");
  });

  it("refuses what isn't a JSONPath", () => {
    expect(jsonPathError("tags")).toContain("isn't a JSONPath");
    expect(jsonPathError("$.a[")).toContain("isn't a JSONPath");
  });

  // Both would run on JavaScript's backtracking engine, where "(a+)+$" hangs the worker.
  it.each([`$[?search(@.a, "(a+)+")]`, `$[?match(@.a, "(a+)+")]`])(
    "refuses a regex function, which would skip RE2: %s",
    (path) => {
      expect(jsonPathError(path)).toContain("unknown function");
    },
  );

  it("refuses a path whose selector lists could multiply its results", () => {
    expect(jsonPathError("$.a[*,*,*,*]")).toContain("selector");
    expect(jsonPathError("$[*,*][*,*]")).toBeUndefined();
    expect(jsonPathError("$[*,*][*,*][*,*]")).toContain("selector");
  });

  it("refuses a second descendant segment, which would multiply with the data's depth", () => {
    expect(jsonPathError("$..a..b")).toContain("descendant");
    expect(jsonPathError("$..*[?@..a]")).toContain("descendant");
  });

  // A filter that starts again from the root walks the whole of `raw` for every node it tests, so
  // each level of nesting multiplies the time.
  it.each(["$.*[?$.*]", "$.*[?$.*[?$.*[?$.*]]]", "$.*[?$..*]", "$[?count($..*) > 1]"])(
    "refuses a filter that goes back to the root: %s",
    (path) => {
      expect(jsonPathError(path)).toContain("root");
    },
  );

  it("still allows a filter nested on the current node, which only walks downwards", () => {
    expect(jsonPathError("$.*[?@.*[?@.*[?@.a]]]")).toBeUndefined();
  });

  it("reports a syntax error without the library's class name", () => {
    const error = jsonPathError("$.a[");
    expect(error).not.toContain("JSONPathSyntaxError");
    expect(error).not.toContain("\n");
  });

  it("refuses a path over the length cap", () => {
    expect(jsonPathError(`$${".a".repeat(499)}`)).toBeUndefined();
    expect(jsonPathError(`$${".a".repeat(500)}`)).toContain("1000");
  });
});

describe("jsonPathFansOut", () => {
  it.each(["$.dc.creators[0]", "$.items[12].title", "$", "$['a b'].c"])(
    "doesn't count a path of only names and indexes: %s",
    (path) => {
      expect(jsonPathFansOut(path)).toBe(false);
    },
  );

  it.each(["$..name", "$.items[*].name", "$.a[0,1]", "$[?@.rank == 2].name", "$..[*,*]"])(
    "counts a path that can fan out: %s",
    (path) => {
      expect(jsonPathFansOut(path)).toBe(true);
    },
  );
});

describe("jsonPathNodeCount", () => {
  it("counts the root and every value inside an array or an object", () => {
    expect(jsonPathNodeCount(null)).toBe(1);
    expect(jsonPathNodeCount({ a: 1, b: [2, 3] })).toBe(5);
    expect(jsonPathNodeCount([{}, []])).toBe(3);
  });

  // A 10 MB payload would otherwise cost a full walk to find out it's over the limit.
  it("stops one past the limit it's given", () => {
    const wide = { a: Array.from({ length: 5000 }, (_, i) => i) };
    expect(jsonPathNodeCount(wide, 100)).toBe(101);
    expect(jsonPathNodeCount(wide)).toBe(5002);
  });

  it("counts a payload nested too deeply to walk with jsonPathValues", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 500; i++) deep = [deep];
    expect(jsonPathNodeCount(deep)).toBe(501);
  });
});
