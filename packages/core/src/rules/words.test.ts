import { describe, expect, it } from "vitest";
import type { Condition } from "./schema.ts";
import { conditionToWords } from "./words.ts";

describe("conditionToWords", () => {
  describe("the Rule model page's example Conditions", () => {
    it.each<[string, Condition, string]>([
      [
        "the Classifier",
        {
          all: [
            { field: "source.type", op: "is", value: "rss" },
            { field: "title", op: "matches", value: "(?i)launch|introducing" },
            { not: { field: "author", op: "in", value: ["me"] } },
          ],
        },
        'Source type is rss and Title matches "(?i)launch|introducing" and Author is not me',
      ],
      [
        "the alert",
        {
          all: [
            { field: "category", op: "is", value: "security-advisory" },
            { field: "severity", op: "gte", value: 4 },
          ],
        },
        "Category is security-advisory and Severity is at least 4",
      ],
      [
        "the Extractor Rule",
        { field: "category", op: "is", value: "security-advisory" },
        "Category is security-advisory",
      ],
    ])("reads %s as a sentence", (_, condition, words) => {
      expect(conditionToWords(condition)).toBe(words);
    });
  });

  describe("each operator", () => {
    it.each<[string, Condition, string]>([
      ["is", { field: "severity", op: "is", value: 5 }, "Severity is 5"],
      ["in", { field: "category", op: "in", value: ["lead", "bug"] }, "Category is one of lead, bug"],
      ["in with one value", { field: "author", op: "in", value: ["me"] }, "Author is me"],
      ["contains", { field: "body", op: "contains", value: "launch" }, 'Body contains "launch"'],
      ["matches", { field: "title", op: "matches", value: "v\\d" }, 'Title matches "v\\d"'],
      ["gte", { field: "importance", op: "gte", value: 3 }, "Importance is at least 3"],
      ["lte", { field: "severity", op: "lte", value: 2 }, "Severity is at most 2"],
      ["exists", { field: "url", op: "exists" }, "URL is present"],
    ])("renders %s", (_, condition, words) => {
      expect(conditionToWords(condition)).toBe(words);
    });
  });

  describe("each operator under not", () => {
    // "Not at least 4" isn't "below 4": a missing field meets the first and not the second.
    it.each<[string, Condition, string]>([
      ["is", { field: "severity", op: "is", value: 5 }, "Severity is not 5"],
      ["in", { field: "category", op: "in", value: ["lead", "bug"] }, "Category is not one of lead, bug"],
      ["contains", { field: "body", op: "contains", value: "x" }, 'Body doesn\'t contain "x"'],
      ["matches", { field: "title", op: "matches", value: "x" }, 'Title doesn\'t match "x"'],
      ["gte", { field: "severity", op: "gte", value: 4 }, "Severity is not at least 4"],
      ["lte", { field: "severity", op: "lte", value: 2 }, "Severity is not at most 2"],
      ["exists", { field: "url", op: "exists" }, "URL is not present"],
    ])("renders %s", (_, condition, words) => {
      expect(conditionToWords({ not: condition })).toBe(words);
    });
  });

  it.each([
    ["source", "source", "Source"],
    ["language", "language", "Language"],
    ["an extracted field", "fields.price", "Field price"],
  ])("names %s", (_, field, name) => {
    expect(conditionToWords({ field, op: "exists" })).toBe(`${name} is present`);
  });

  describe("nesting", () => {
    const a: Condition = { field: "title", op: "is", value: "a" };
    const b: Condition = { field: "title", op: "is", value: "b" };
    const c: Condition = { field: "title", op: "is", value: "c" };

    it.each<[string, Condition, string]>([
      ["any", { any: [a, b] }, "Title is a or Title is b"],
      ["a group of one, without brackets", { all: [a] }, "Title is a"],
      ["a group inside a group", { all: [a, { any: [b, c] }] }, "Title is a and (Title is b or Title is c)"],
      ["a group of one inside a group", { all: [a, { any: [b] }] }, "Title is a and Title is b"],
      ["not around a group", { not: { all: [a, b] } }, "Not (Title is a and Title is b)"],
      ["not around a group of one", { not: { any: [a] } }, "Title is not a"],
      ["not around not", { not: { not: a } }, "Not (Title is not a)"],
      ["not inside a group", { any: [a, { not: { all: [b, c] } }] }, "Title is a or not (Title is b and Title is c)"],
    ])("renders %s", (_, condition, words) => {
      expect(conditionToWords(condition)).toBe(words);
    });
  });
});
