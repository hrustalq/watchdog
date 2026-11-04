import { describe, expect, it } from "vitest";
import { jsonPathError, jsonPathValues } from "./jsonpath.ts";

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

  it("gives no values, rather than throwing, for raw nested too deeply to walk", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 500; i++) deep = [deep];
    expect(jsonPathValues("$..*", deep)).toBeUndefined();
  });
});

describe("jsonPathError", () => {
  it.each(["$", "$.a.b", "$.tags[*].name", "$[?@.a > 1 && @.b == 'x'].c", "$.a[0,1,2,3,4]", "$..a..b"])(
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
  it.each([`$[?search(@.a, "(a+)+$")]`, `$[?match(@.a, "(a+)+")]`])(
    "refuses a regex function, which would skip RE2: %s",
    (path) => {
      expect(jsonPathError(path)).toContain("unknown function");
    },
  );

  it("refuses a path whose selector lists could multiply its results", () => {
    expect(jsonPathError("$.a[*,*,*,*,*,*]")).toContain("selector");
    expect(jsonPathError("$[*,*][*,*][*,*]")).toBeUndefined();
    expect(jsonPathError("$[*,*][*,*][*,*][*,*][*,*]")).toContain("selector");
  });

  it("refuses more than two descendant segments, which multiply with the data's depth", () => {
    expect(jsonPathError("$..a..b..c")).toContain("descendant");
  });

  it("refuses a path over the length cap", () => {
    expect(jsonPathError(`$${".a".repeat(499)}`)).toBeUndefined();
    expect(jsonPathError(`$${".a".repeat(500)}`)).toContain("1000");
  });
});
