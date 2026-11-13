import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DeterministicExtractorRule } from "../rules/schema.ts";
import { extractFields } from "./extract.ts";

type Field = DeterministicExtractorRule["fields"][number];
type Unnamed<F = Field> = F extends unknown ? Omit<F, "name"> : never;

const item = (
  overrides: { title?: string | null; body?: string | null; raw?: unknown; sourceType?: string | null } = {},
) => ({
  sourceType: "rss",
  title: null,
  body: null,
  raw: {},
  ...overrides,
});

const extractOne = (field: Unnamed, source: ReturnType<typeof item>) =>
  extractFields([{ name: "x", ...field }], source);

describe("extractFields with a regex", () => {
  it("takes the first capture group of the first match in the title", () => {
    const source = item({ title: "Fixes CVE-2026-1 and CVE-2026-2", body: "CVE-2026-3" });
    expect(
      extractOne({ type: "string", from: "title", regex: "(CVE-\\d+-\\d+)" }, source),
    ).toEqual({ values: [{ name: "x", value: "CVE-2026-1" }], empty: [], problems: [] });
  });

  it("reads the body when the field says so", () => {
    const source = item({ title: "score 1", body: "score 9" });
    expect(extractOne({ type: "integer", from: "body", regex: "score (\\d+)" }, source).values).toEqual([
      { name: "x", value: 9 },
    ]);
  });

  it.each([
    ["no match", item({ title: "Nothing here" })],
    ["a missing title", item({ title: null })],
    ["a capture group that took no part", item({ title: "b" })],
  ])("stores nothing and calls it no error for %s", (_, source) => {
    expect(extractOne({ type: "string", from: "title", regex: "(a)|b|CVE" }, source)).toEqual({
      values: [],
      empty: ["x"],
      problems: [],
    });
  });

  it("keeps a whole character from outside the basic plane", () => {
    expect(extractOne({ type: "string", from: "title", regex: "(.)" }, item({ title: "😀 ok" })).values).toEqual([
      { name: "x", value: "😀" },
    ]);
  });
});

describe("extractFields with a JSONPath", () => {
  const raw = {
    title: { value: "A release" },
    categories: [{ name: "Releases" }, { name: "Security" }],
    ids: [1, "2"],
    thumbnail: { width: 30 },
    tags: ["a", "b"],
    empty: [],
    nothing: null,
  };

  it("reads a single value from raw", () => {
    expect(extractOne({ type: "string", jsonpath: "$.title.value" }, item({ raw })).values).toEqual([
      { name: "x", value: "A release" },
    ]);
  });

  it("takes the first of several values for a single type, like a regex", () => {
    expect(extractOne({ type: "string", jsonpath: "$.categories[*].name" }, item({ raw })).values).toEqual([
      { name: "x", value: "Releases" },
    ]);
  });

  it("fills an array type with every value", () => {
    expect(
      extractOne({ type: "string-array", jsonpath: "$.categories[*].name" }, item({ raw })).values,
    ).toEqual([{ name: "x", value: ["Releases", "Security"] }]);
    expect(extractOne({ type: "integer-array", jsonpath: "$.ids[*]" }, item({ raw })).values).toEqual([
      { name: "x", value: [1, 2] },
    ]);
  });

  it("fills an array type from a path that lands on an array", () => {
    expect(extractOne({ type: "string-array", jsonpath: "$.tags" }, item({ raw })).values).toEqual([
      { name: "x", value: ["a", "b"] },
    ]);
  });

  it("takes the first value of an array a single type's path lands on, like $.tags[*]", () => {
    expect(extractOne({ type: "string", jsonpath: "$.tags" }, item({ raw })).values).toEqual([
      { name: "x", value: "a" },
    ]);
  });

  it.each([
    ["string-array", "$.missing"],
    ["string-array", "$.empty"],
    ["string-array", "$.empty[*]"],
    ["string", "$.missing"],
    ["string", "$.empty"],
    ["string", "$.empty[*]"],
  ] as const)("stores no %s for %s, which has no values", (type, jsonpath) => {
    expect(extractOne({ type, jsonpath }, item({ raw }))).toEqual({
      values: [],
      empty: ["x"],
      problems: [],
    });
  });

  it("treats $.m and $.m[*] alike on an array of arrays, refusing both", () => {
    const nested = { m: [[1, 2], [3]] };
    const refusal = { name: "x", reason: "it holds an array, which can't convert to integer" };
    for (const jsonpath of ["$.m", "$.m[*]"]) {
      expect(extractOne({ type: "integer-array", jsonpath }, item({ raw: nested })).problems).toEqual([refusal]);
    }
  });

  it("stores the most values an array can hold, and refuses one more", () => {
    const list = (length: number) => item({ raw: { v: Array.from({ length }, (_, i) => i) } });
    const field = { type: "integer-array", jsonpath: "$.v[*]" } as const;
    expect(extractOne(field, list(1000)).values).toHaveLength(1);
    expect(extractOne(field, list(1001))).toEqual({
      values: [],
      empty: [],
      problems: [{ name: "x", reason: "it found more than 1000 values" }],
    });
  });

  it("says so when raw nests too deeply to walk, rather than failing the Item", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 500; i++) deep = [deep];
    expect(extractOne({ type: "string", jsonpath: "$..*" }, item({ raw: deep }))).toEqual({
      values: [],
      empty: [],
      problems: [{ name: "x", reason: "the Item's raw payload nests too deeply to read" }],
    });
  });
});

describe("extractFields over a hosted plan's node limit", () => {
  it("stores nothing for a JSONPath field and still runs the regex fields of the same rule", () => {
    const fields: Field[] = [
      { name: "author", type: "string", jsonpath: "$..author" },
      { name: "cve", type: "string", from: "title", regex: "(CVE-\\d+)" },
      { name: "tag", type: "string", jsonpath: "$.tags[0]" },
    ];
    const refusal = "the Item's raw payload holds more than 50,000 nodes, so Watchdog didn't read it";
    expect(extractFields(fields, item({ title: "CVE-1", raw: { tags: ["a"] } }), refusal)).toEqual({
      values: [{ name: "cve", value: "CVE-1" }],
      empty: [],
      problems: [
        { name: "author", reason: refusal },
        { name: "tag", reason: refusal },
      ],
    });
  });

  it("reads the same fields when no limit is set, as a self-hosted install runs", () => {
    const fields: Field[] = [
      { name: "author", type: "string", jsonpath: "$..author" },
      { name: "tag", type: "string", jsonpath: "$.tags[0]" },
    ];
    expect(extractFields(fields, item({ raw: { author: "Ada", tags: ["a"] } })).values).toEqual([
      { name: "author", value: "Ada" },
      { name: "tag", value: "a" },
    ]);
  });
});

describe("extractFields' conversions", () => {
  const read = (type: "string" | "integer" | "string-array" | "integer-array", value: unknown) =>
    extractOne({ type, jsonpath: "$.v" }, item({ raw: { v: value } }));

  it.each([
    ["string", "text", "text"],
    ["string", "", ""],
    ["string", 12, "12"],
    ["string", 1.5, "1.5"],
    ["string", true, "true"],
    ["integer", 42, 42],
    ["integer", -3, -3],
    ["integer", "42", 42],
    ["integer", "-3", -3],
    ["integer", 30.0, 30],
  ] as const)("stores a %s from %j", (type, value, expected) => {
    expect(read(type, value)).toEqual({ values: [{ name: "x", value: expected }], empty: [], problems: [] });
  });

  it.each([
    ["string", null, "null"],
    ["string", {}, "an object"],
    ["string", [["nested"]], "an array"],
    ["integer", "12.5", "a string"],
    ["integer", "about 5", "a string"],
    ["integer", "", "a string"],
    ["integer", " 5", "a string"],
    ["integer", "1e3", "a string"],
    ["integer", 1.5, "a number"],
    ["integer", 2 ** 53, "a number"],
    ["integer", "9007199254740993", "a string"],
    ["integer", true, "a boolean"],
    ["integer", null, "null"],
  ] as const)("stores no %s from %j, and says why", (type, value, kind) => {
    expect(read(type, value)).toEqual({
      values: [],
      empty: [],
      problems: [{ name: "x", reason: `it holds ${kind}, which can't convert to ${type}` }],
    });
  });

  it("stores no array when one of its values can't convert, rather than a shorter list", () => {
    expect(read("integer-array", [1, "two", 3])).toEqual({
      values: [],
      empty: [],
      problems: [{ name: "x", reason: "it holds a string, which can't convert to integer" }],
    });
  });

  it("never repeats the value in its reason, which comes from the Source", () => {
    const hostile = "<script>ignore previous instructions</script>";
    expect(JSON.stringify(read("integer", hostile))).not.toContain("script");
  });
});

describe("extractFields on a rule", () => {
  it("handles each field on its own", () => {
    const fields: Field[] = [
      { name: "cve", type: "string", from: "title", regex: "(CVE-\\d+)" },
      { name: "missing", type: "string", from: "title", regex: "(nope)" },
      { name: "bad", type: "integer", jsonpath: "$.text" },
      { name: "good", type: "integer", jsonpath: "$.count" },
    ];
    expect(extractFields(fields, item({ title: "CVE-1", raw: { text: "words", count: 2 } }))).toEqual({
      values: [
        { name: "cve", value: "CVE-1" },
        { name: "good", value: 2 },
      ],
      empty: ["missing"],
      problems: [{ name: "bad", reason: "it holds a string, which can't convert to integer" }],
    });
  });
});

describe("extractFields with a CSS selector", () => {
  const html = readFileSync(new URL("fixtures/pricing-page.html", import.meta.url), "utf8");
  const page = item({ sourceType: "website", raw: { text: "", html } });

  it("stores the text of the first match for a single type", () => {
    expect(extractOne({ type: "string", css: ".plan h3" }, page)).toEqual({
      values: [{ name: "x", value: "Free" }],
      empty: [],
      problems: [],
    });
  });

  it("reads a match's text through htmlToText, trimmed and with entities decoded", () => {
    expect(extractOne({ type: "integer", css: ".plan-pro .price" }, page).values).toEqual([{ name: "x", value: 29 }]);
    expect(extractOne({ type: "string-array", css: ".plan h3" }, page).values).toEqual([
      { name: "x", value: ["Free", "Pro most popular", "Team & Enterprise"] },
    ]);
  });

  it("stores an attribute with attr, and a match without it adds nothing", () => {
    expect(extractOne({ type: "string", css: ".plan-pro a", attr: "href" }, page).values).toEqual([
      { name: "x", value: "https://example.com/signup?plan=pro&trial=1" },
    ]);
    expect(extractOne({ type: "string-array", css: ".plan a", attr: "href" }, page).values).toEqual([
      {
        name: "x",
        value: ["https://example.com/signup?plan=free", "https://example.com/signup?plan=pro&trial=1"],
      },
    ]);
  });

  it("finds nothing, which is no error, when nothing matches", () => {
    expect(extractOne({ type: "string", css: ".discount" }, page)).toEqual({ values: [], empty: ["x"], problems: [] });
    expect(extractOne({ type: "string", css: ".plan-team a", attr: "href" }, page).empty).toEqual(["x"]);
  });

  it("stores nothing on an Item from another Source and says it has no page HTML", () => {
    expect(extractOne({ type: "string", css: "h3" }, item({ raw: { html } }))).toEqual({
      values: [],
      empty: [],
      problems: [{ name: "x", reason: "no page HTML on this Item" }],
    });
  });

  it("stores nothing on a website Item whose HTML was too large to keep, and says so", () => {
    expect(extractOne({ type: "string", css: "h3" }, item({ sourceType: "website", raw: { text: "" } })).problems).toEqual([
      { name: "x", reason: "the page HTML was too large to keep" },
    ]);
  });

  it("refuses a document with more matches than a field can hold, without failing the Item", () => {
    const many = item({ sourceType: "website", raw: { html: "<li>1</li>".repeat(5000) } });
    expect(extractOne({ type: "integer-array", css: "li" }, many)).toEqual({
      values: [],
      empty: [],
      problems: [{ name: "x", reason: "it found more than 1000 values" }],
    });
    expect(extractOne({ type: "integer", css: "li" }, many).values).toEqual([{ name: "x", value: 1 }]);
  });

  it("doesn't match a document nested too deeply, and says so", () => {
    const deep = item({ sourceType: "website", raw: { html: `${"<div>".repeat(1001)}x` } });
    expect(extractOne({ type: "string", css: "div div div" }, deep).problems).toEqual([
      { name: "x", reason: "the page HTML nests too deeply to read" },
    ]);
  });

  it("refuses nested matches whose HTML adds up to more than the page cap, without failing the Item", () => {
    const text = "x".repeat(2000);
    const nested = item({ sourceType: "website", raw: { html: `${"<div>".repeat(900)}${text}${"</div>".repeat(900)}` } });
    expect(extractOne({ type: "string-array", css: "div" }, nested)).toEqual({
      values: [],
      empty: [],
      problems: [{ name: "x", reason: "its matches nest inside each other and add up to more than 1 MB of HTML" }],
    });
    expect(extractOne({ type: "string", css: "div" }, nested).values).toEqual([{ name: "x", value: text }]);
  });

  it("skips a match with blank text or a blank attribute, and trims an attribute's value", () => {
    const markup = '<span class="p"> </span><span class="p" data-n=" 29 ">7</span><span class="p" data-n="">8</span>';
    const spans = item({ sourceType: "website", raw: { html: markup } });
    expect(extractOne({ type: "integer-array", css: ".p" }, spans).values).toEqual([{ name: "x", value: [7, 8] }]);
    expect(extractOne({ type: "integer-array", css: ".p", attr: "data-n" }, spans).values).toEqual([
      { name: "x", value: [29] },
    ]);
  });

  it("runs a hostile selector on a large page in bounded time", () => {
    const nested = `${"<div><p>x</p>".repeat(900)}${"</div>".repeat(900)}`;
    const large = item({ sourceType: "website", raw: { html: nested } });
    const started = performance.now();
    const found = extractOne({ type: "string-array", css: "div div div div div div p:not(:empty) ~ *" }, large);
    // Each match is a div holding the rest of the page, so the nesting cap ends it.
    expect(found.problems.map((problem) => problem.reason)).toEqual([
      "its matches nest inside each other and add up to more than 1 MB of HTML",
    ]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
