import { describe, expect, it } from "vitest";
import { draftFromYaml, draftToYaml } from "./draft.ts";
import { ruleSchema } from "./schema.ts";
import { type StarterContext, type StarterSource, starterRulesFor } from "./starters.ts";

const nothing: StarterContext = {
  declaredFields: [],
  existingNames: { classifier: [], extractor: [] },
};

const source = (type: string, config: unknown = {}): StarterSource => ({
  type,
  config,
});

/** Every starter has to be a rule the canonical model accepts, or one click can't save it. */
function parsed(rule: ReturnType<typeof starterRulesFor>[number]) {
  const result = ruleSchema.safeParse(draftFromYaml(draftToYaml(rule.draft)));
  if (!result.success) throw new Error(`${rule.name}: ${result.error.message}`);
  return result.data;
}

describe("starterRulesFor", () => {
  it("offers two Classifiers and a Version Extractor Rule for a feed, all scoped to the Source type", () => {
    const rules = starterRulesFor(source("rss"), nothing);

    expect(rules.map(({ name }) => name)).toEqual(["Bug reports", "Feature requests", "Version"]);
    for (const rule of rules) {
      const saved = parsed(rule);
      const when = "when" in saved ? saved.when : undefined;
      expect(JSON.stringify(when)).toContain('"source.type"');
      expect(JSON.stringify(when)).toContain('"rss"');
    }
    expect(rules[0]?.draft).toMatchObject({ assign: ["bug-report"] });
    expect(rules[1]?.draft).toMatchObject({ assign: ["feature-request"] });
    expect(rules[2]?.draft).toMatchObject({
      fields: [{ name: "version", type: "string", from: "title" }],
    });
  });

  it("offers release starters for a GitHub releases Source", () => {
    const rules = starterRulesFor(source("github", { kind: "releases", repo: "acme/app" }), nothing);

    expect(rules.map(({ name }) => name)).toEqual(["Security releases", "Breaking changes", "Version"]);
    expect(rules[0]?.draft).toMatchObject({ assign: ["security"] });
    expect(rules[1]?.draft).toMatchObject({ assign: ["breaking-change"] });
    rules.forEach(parsed);
  });

  it("keeps the content starters for every other Source type", () => {
    for (const type of ["website", "webhook", "telegram", "github"]) {
      expect(starterRulesFor(source(type, { kind: "issues" }), nothing).map(({ key }) => key)).toEqual([
        "bug-reports",
        "feature-requests",
        "version",
      ]);
    }
  });

  it("hides a starter whose rule name the Workspace already uses", () => {
    const rules = starterRulesFor(source("rss"), {
      declaredFields: [],
      existingNames: { classifier: ["Bug reports"], extractor: [] },
    });

    expect(rules.map(({ name }) => name)).toEqual(["Feature requests", "Version"]);
  });

  it("hides the Version Extractor Rule when a field named version is already declared", () => {
    const rules = starterRulesFor(source("rss"), {
      declaredFields: ["version"],
      existingNames: { classifier: [], extractor: [] },
    });

    expect(rules.map(({ name }) => name)).toEqual(["Bug reports", "Feature requests"]);
  });

  it("gives every starter a name and a one-line description", () => {
    for (const rule of starterRulesFor(source("rss"), nothing)) {
      expect(rule.name.length).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(0);
      expect(rule.description).not.toContain("\n");
    }
  });
});
