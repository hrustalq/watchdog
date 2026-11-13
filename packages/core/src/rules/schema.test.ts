import { describe, expect, it } from "vitest";
import {
  actionSchema,
  agentClassifierSchema,
  agentExtractorRuleSchema,
  conditionSchema,
  deterministicClassifierSchema,
  deterministicExtractorRuleSchema,
  maxLabelLength,
  maxPromptLength,
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
    ["an extracted field called __proto__", { field: "fields.__proto__", op: "exists" }, "__proto__"],
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

  it.each([
    ["a field that can't become text", { field: { toString: 1 }, op: "exists" }],
    ["no field", { op: "exists" }],
  ])("says what a field is for %s", (_, condition) => {
    const { message } = issuesOf(conditionSchema.safeParse(condition))[0] ?? { message: "" };
    expect(message).toContain("field");
    expect(message).not.toContain("undefined");
  });

  it.each([
    ["is", { field: "url", op: "is", value: true }],
    ["is with no value", { field: "url", op: "is" }],
    ["in", { field: "url", op: "in", value: [true] }],
  ])("says what value %s takes", (_, condition) => {
    const { message } = issuesOf(conditionSchema.safeParse(condition))[0] ?? { message: "" };
    expect(message).toContain("string or a number");
  });

  it.each([
    ["nothing", undefined],
    ["text", "title"],
    ["null", null],
  ])("says what a Condition is for %s", (_, condition) => {
    const { message } = issuesOf(conditionSchema.safeParse(condition))[0] ?? { message: "" };
    expect(message).toContain("all, any, not");
  });

  describe("its size", () => {
    const nested = (depth: number) => {
      let condition: object = title;
      for (let i = 1; i < depth; i++) condition = { not: condition };
      return condition;
    };

    it("accepts 50 nodes", () => {
      expect(conditionSchema.safeParse({ all: Array(49).fill(title) }).success).toBe(true);
      expect(conditionSchema.safeParse(nested(50)).success).toBe(true);
    });

    it("refuses 51 nodes, which would let one rule multiply the regex budget", () => {
      const { message } = issuesOf(conditionSchema.safeParse({ all: Array(50).fill(title) }))[0] ?? {
        message: "",
      };
      expect(message).toContain("50");
      expect(conditionSchema.safeParse(nested(51)).success).toBe(false);
    });

    it("returns an error for nesting that would overflow the stack, without throwing", () => {
      expect(conditionSchema.safeParse(nested(100_000)).success).toBe(false);
    });

    it("refuses a tree that contains itself", () => {
      const loop: { not?: object } = {};
      loop.not = loop;
      expect(conditionSchema.safeParse(loop).success).toBe(false);
      const list: object[] = [];
      list.push({ all: list });
      expect(conditionSchema.safeParse({ all: list }).success).toBe(false);
    });

    it("applies at a rule's stage too", () => {
      const when = { all: Array(50).fill(title) };
      expect(
        deterministicClassifierSchema.safeParse({ classifier: "a", when, assign: ["b"] }).success,
      ).toBe(false);
    });
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

  it("refuses an empty prompt, a blank one, and no Categories", () => {
    expect(agentClassifierSchema.safeParse({ ...classifier, prompt: "" }).success).toBe(false);
    expect(agentClassifierSchema.safeParse({ ...classifier, prompt: " \n " }).success).toBe(false);
    expect(agentClassifierSchema.safeParse({ ...classifier, categories: [] }).success).toBe(false);
  });

  it("keeps a prompt's own whitespace", () => {
    const prompt = "  Sort it.\n";
    expect(agentClassifierSchema.parse({ ...classifier, prompt }).prompt).toBe(prompt);
  });
});

describe("the size of the text a rule holds", () => {
  const classifier = { classifier: "sorter", prompt: "Sort it.", categories: ["lead"] };
  const withPrompt = (length: number) => ({ ...classifier, prompt: "x".repeat(length) });
  const withCategory = (length: number) => ({ ...classifier, categories: ["x".repeat(length)] });

  it("accepts a prompt at its limit and refuses one character more, beside the prompt", () => {
    expect(agentClassifierSchema.safeParse(withPrompt(maxPromptLength - 1)).success).toBe(true);
    expect(agentClassifierSchema.safeParse(withPrompt(maxPromptLength)).success).toBe(true);
    const issue = issuesOf(agentClassifierSchema.safeParse(withPrompt(maxPromptLength + 1)))[0];
    expect(issue?.path).toEqual(["prompt"]);
    expect(issue?.message).toContain(maxPromptLength.toLocaleString("en"));
  });

  it("accepts a Category name at its limit and refuses one character more, beside the name", () => {
    expect(agentClassifierSchema.safeParse(withCategory(maxLabelLength - 1)).success).toBe(true);
    expect(agentClassifierSchema.safeParse(withCategory(maxLabelLength)).success).toBe(true);
    const issue = issuesOf(agentClassifierSchema.safeParse(withCategory(maxLabelLength + 1)))[0];
    expect(issue?.path).toEqual(["categories", 0]);
    expect(issue?.message).toContain(maxLabelLength.toLocaleString("en"));
  });

  it("holds on an Agent-backed Extractor Rule and on a deterministic Classifier's assign", () => {
    const extractor = {
      extractor: "pricing",
      when: { field: "title", op: "exists" },
      prompt: "x".repeat(maxPromptLength + 1),
      fields: [{ name: "price", type: "string" }],
    };
    expect(issuesOf(agentExtractorRuleSchema.safeParse(extractor))[0]?.path).toEqual(["prompt"]);

    const assign = { classifier: "c", when: { field: "title", op: "exists" }, assign: ["x".repeat(maxLabelLength + 1)] };
    expect(issuesOf(deterministicClassifierSchema.safeParse(assign))[0]?.path).toEqual(["assign", 0]);
  });

  it("counts a name after trimming it, and leaves a rule's own name at the same limit", () => {
    const padded = { ...classifier, classifier: ` ${"x".repeat(maxLabelLength)} ` };
    expect(agentClassifierSchema.safeParse(padded).success).toBe(true);
    const issue = issuesOf(agentClassifierSchema.safeParse({ ...padded, classifier: "x".repeat(maxLabelLength + 1) }))[0];
    expect(issue?.path).toEqual(["classifier"]);
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
      { name: "plans", type: "string-array", css: ".plan h3" },
      { name: "signup", type: "string", css: "a.signup", attr: "href" },
    ],
  };

  it("accepts regex fields on title or body, JSONPath fields and CSS fields", () => {
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
    ["a JSONPath that doesn't parse", { name: "x", type: "string", jsonpath: "$.a[" }, "isn't a JSONPath"],
    ["code in a JSONPath filter", { name: "x", type: "string", jsonpath: "$[?process.exit(1)]" }, "isn't a JSONPath"],
    ["a JSONPath regex function", { name: "x", type: "string", jsonpath: '$[?search(@.a, "b")]' }, "unknown function"],
    ["a JSONPath that fans out", { name: "x", type: "string", jsonpath: "$[*,*,*,*,*,*]" }, "selector"],
    ["a type it doesn't know", { name: "x", type: "date", jsonpath: "$.a" }, "type"],
    ["a CSS selector that doesn't parse", { name: "x", type: "string", css: ".price[" }, "isn't a CSS selector"],
    ["a CSS selector css-select can't match", { name: "x", type: "string", css: "p::before" }, "isn't a CSS selector"],
    ["a CSS selector using :has()", { name: "x", type: "string", css: "li:has(.price)" }, ":has()"],
    ["a nested :has()", { name: "x", type: "string", css: "main :is(p, div:has(span))" }, ":has()"],
    ["a CSS selector over the cap", { name: "x", type: "string", css: `.${"a".repeat(1000)}` }, "1,000 characters"],
    ["a blank CSS attribute", { name: "x", type: "string", css: "a", attr: "" }, "attr"],
    ["a CSS attribute with a space", { name: "x", type: "string", css: "a", attr: "href " }, "attr"],
    ["a quoted CSS attribute", { name: "x", type: "string", css: "a", attr: "'href'" }, "attr"],
    ["an attribute on a JSONPath field", { name: "x", type: "string", jsonpath: "$.a", attr: "href" }, "attr"],
    ["a field that says neither", { name: "x", type: "string" }, "one of regex, jsonpath or css"],
    ["a field that says both", { name: "x", type: "string", from: "body", regex: "(x)", jsonpath: "$" }, "one of regex, jsonpath or css"],
    ["a field with JSONPath and CSS", { name: "x", type: "string", jsonpath: "$", css: "a" }, "one of regex, jsonpath or css"],
    ["a name with a dot", { name: "a.b", type: "string", jsonpath: "$.a" }, "name"],
    ["the name __proto__", { name: "__proto__", type: "string", jsonpath: "$.a" }, "name"],
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

  it("accepts 50 fields and refuses 51, since each can run a regex", () => {
    const fields = Array.from({ length: 51 }, (_, i) => ({
      name: `f${String(i)}`,
      type: "string",
      from: "body",
      regex: "(x)",
    }));
    const parse = (list: object[]) =>
      deterministicExtractorRuleSchema.safeParse({ ...rule, fields: list }).success;
    expect(parse(fields.slice(1))).toBe(true);
    expect(parse(fields)).toBe(false);
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

  it("refuses a blank prompt", () => {
    expect(agentExtractorRuleSchema.safeParse({ ...rule, prompt: "  " }).success).toBe(false);
  });

  it("refuses a field that says where to read from, because the Agent decides", () => {
    const fields = [{ name: "x", type: "string", jsonpath: "$.a" }];
    expect(agentExtractorRuleSchema.safeParse({ ...rule, fields }).success).toBe(false);
  });
});

describe("actionSchema", () => {
  const when = { field: "severity", op: "gte", value: 4 };
  const alert = { action: "critical", when, kind: "alert", destinations: ["ops-chat", "me"] };
  const webhook = { action: "to-crm", when, kind: "webhook", destinations: ["crm-inbox"] };
  const digest = {
    action: "weekly",
    when,
    kind: "digest",
    schedule: "0 9 * * 1",
    destinations: ["me"],
  };

  it.each([
    ["an alert", alert],
    ["a webhook", webhook],
    ["a Digest", digest],
  ])("accepts %s", (_, action) => {
    expect(actionSchema.parse(action)).toEqual(action);
  });

  it.each(["severity", "importance", "fields.price", "category", "source", "title"])(
    "lets when test %s, since an Action runs after every other stage",
    (field) => {
      expect(actionSchema.safeParse({ ...alert, when: { field, op: "exists" } }).success).toBe(true);
    },
  );

  it("refuses a Condition over the 50-part cap", () => {
    const parts = { all: Array(50).fill(when) };
    expect(issuesOf(actionSchema.safeParse({ ...alert, when: parts }))[0]?.message).toContain("50");
  });

  it("refuses a field no rule can test, pointing into when", () => {
    const issue = issuesOf(actionSchema.safeParse({ ...alert, when: { field: "nope", op: "exists" } }))[0];
    expect(issue?.message).toContain('"nope"');
    expect(issue?.path).toEqual(["when", "field"]);
  });

  it("refuses a Digest without a schedule, naming the field", () => {
    const { schedule: _schedule, ...withoutSchedule } = digest;
    expect(issuesOf(actionSchema.safeParse(withoutSchedule))[0]?.path).toEqual(["schedule"]);
  });

  it.each([
    ["an alert", alert],
    ["a webhook", webhook],
  ])("refuses a schedule on %s, naming the field", (_, action) => {
    const issue = issuesOf(actionSchema.safeParse({ ...action, schedule: "0 9 * * 1" }))[0];
    expect(issue?.message).toContain("schedule");
  });

  it.each([
    ["no list", undefined],
    ["an empty list", []],
    ["a blank name", [" "]],
  ])("refuses %s of destinations, naming the field", (_, destinations) => {
    const issue = issuesOf(actionSchema.safeParse({ ...alert, destinations }))[0];
    expect(issue?.path[0]).toBe("destinations");
  });

  it.each([
    ["no kind", undefined],
    ["a kind it doesn't know", "sms"],
  ])("says what a kind is for %s", (_, kind) => {
    const { message } = issuesOf(actionSchema.safeParse({ ...alert, kind }))[0] ?? { message: "" };
    expect(message).toContain("alert, webhook or digest");
  });

  it("refuses a blank name and a key it doesn't know", () => {
    expect(actionSchema.safeParse({ ...alert, action: " " }).success).toBe(false);
    expect(actionSchema.safeParse({ ...alert, notes: "x" }).success).toBe(false);
  });

  it.each([
    ["text that isn't cron", "weekly", "isn't a cron expression"],
    ["too few fields", "* * * *", "isn't a cron expression"],
    ["a date that never comes", "0 0 31 2 *", "isn't a cron expression"],
  ])("refuses a Digest whose schedule is %s", (_, schedule, expected) => {
    const issue = issuesOf(actionSchema.safeParse({ ...digest, schedule }))[0];
    expect(issue?.message).toContain(expected);
    expect(issue?.path).toEqual(["schedule"]);
  });

  it.each([
    ["a word", "is", "high"],
    ["a number as text", "is", "4"],
    ["a level above the scale", "gte", 9],
    ["a level below the scale", "lte", 0],
    ["a fraction", "is", 2.5],
    ["a word in a list", "in", [4, "high"]],
    ["text to find", "contains", "4"],
    ["a pattern", "matches", "4"],
  ])("refuses a Rating test on %s, beside its value", (_, op, value) => {
    for (const field of ["severity", "importance"]) {
      const issue = issuesOf(actionSchema.safeParse({ ...alert, when: { not: { field, op, value } } }))[0];
      expect(issue?.message).toContain("1 to 5");
      expect(issue?.path).toEqual(["when", "not", "value"]);
    }
  });

  it.each([
    ["is", 1],
    ["gte", 5],
    ["lte", 3],
    ["in", [1, 5]],
  ])("accepts a Rating test with %s %j", (op, value) => {
    expect(actionSchema.safeParse({ ...alert, when: { field: "severity", op, value } }).success).toBe(true);
  });

  it("lets a Condition test whether an Item has a Rating", () => {
    const exists = { field: "importance", op: "exists" };
    expect(actionSchema.safeParse({ ...alert, when: exists }).success).toBe(true);
  });

  it.each(["", "   "])("refuses a blank schedule %j as blank, beside the field", (schedule) => {
    const issue = issuesOf(actionSchema.safeParse({ ...digest, schedule }))[0];
    expect(issue?.message).not.toContain("cron");
    expect(issue?.path).toEqual(["schedule"]);
  });

  it("leaves a schedule's minimum interval to the save, which knows the mode", () => {
    expect(actionSchema.safeParse({ ...digest, schedule: "* * * * *" }).success).toBe(true);
  });

  it("keeps a Digest's schedule without the whitespace around it", () => {
    const parsed = actionSchema.parse({ ...digest, schedule: " 0 9 * * 1\n" });
    expect(parsed).toEqual(digest);
  });

  it("refuses a Destination listed twice, pointing at the second", () => {
    const issue = issuesOf(actionSchema.safeParse({ ...alert, destinations: ["me", "x", " me "] }))[0];
    expect(issue?.message).toContain('"me"');
    expect(issue?.path).toEqual(["destinations", 2]);
  });
});

describe("ruleSchema", () => {
  const when = { field: "title", op: "exists" };

  it.each([
    { classifier: "a", when, assign: ["x"] },
    { classifier: "a", prompt: "p", categories: ["x"] },
    { extractor: "a", when, fields: [{ name: "n", type: "string", jsonpath: "$.a" }] },
    { extractor: "a", when, prompt: "p", fields: [{ name: "n", type: "string" }] },
    { action: "a", when, kind: "alert", destinations: ["d"] },
    { action: "a", when, kind: "webhook", destinations: ["d"] },
    { action: "a", when, kind: "digest", schedule: "0 9 * * 1", destinations: ["d"] },
  ])("accepts every rule kind", (rule) => {
    expect(ruleSchema.parse(rule)).toEqual(rule);
  });

  it("keeps the stage's message when it picks the rule's kind itself", () => {
    const rule = { extractor: "a", when: { field: "severity", op: "exists" }, prompt: "p", fields: [] };
    expect(issuesOf(ruleSchema.safeParse(rule)).map((issue) => issue.message).join()).toContain(
      '"severity"',
    );
  });

  it("refuses something that is no rule, naming every kind", () => {
    for (const value of [{ when }, "text", null]) {
      const { message } = issuesOf(ruleSchema.safeParse(value))[0] ?? { message: "" };
      expect(message).toContain("classifier");
      expect(message).toContain("extractor");
      expect(message).toContain("action");
    }
  });

  it("lets an Action test the Rating under not, and still refuses an Extractor Rule that does", () => {
    const notSevere = { not: { field: "severity", op: "gte", value: 4 } };
    const action = { action: "a", when: notSevere, kind: "alert", destinations: ["d"] };
    const extractor = {
      extractor: "a",
      when: notSevere,
      prompt: "p",
      fields: [{ name: "n", type: "string" }],
    };
    expect(ruleSchema.parse(action)).toEqual(action);
    expect(issuesOf(ruleSchema.safeParse(extractor))[0]?.message).toContain('"severity"');
  });
});
