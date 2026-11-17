// Starter rules for the guided setup. They are ordinary rules on the canonical model, so a starter
// saves through the Rules editor's own path and the user can edit it there afterwards.

/** A rule on its way to being saved: the same shape the Rules editor's draft holds. */
export type StarterDraft = Record<string, unknown>;

/** One starter the guided setup offers: saving it creates this rule as it stands. */
export interface StarterRule {
  /** Stable id for the wizard's URL and its form, not the rule's name. */
  key: string;
  name: string;
  /** One line, shown under the name so the list explains itself. */
  description: string;
  type: "classifier" | "extractor";
  draft: StarterDraft;
  /** The fields an Extractor Rule declares, so a wizard can't redeclare one. */
  declares: readonly string[];
}

/** What the Workspace already holds, so a starter can't repeat a rule or a field. */
export interface StarterContext {
  /** The field names another Extractor Rule declares. */
  declaredFields: readonly string[];
  /** The names the Workspace's rules of each type already use. */
  existingNames: { classifier: readonly string[]; extractor: readonly string[] };
}

/** The Source a starter belongs to: its type picks the list and scopes the Condition. */
export interface StarterSource {
  type: string;
  config: unknown;
}

const bugTerms = ["bug", "crash", "error", "broken", "regression"];
const featureTerms = ["feature request", "would be nice", "suggestion", "enhancement"];
const securityTerms = ["security", "vulnerability", "cve", "advisory"];
const breakingTerms = ["breaking"];

/** A Condition that holds for this kind of Source's Items, and only when their text mentions a term. */
function wordsIn(type: string, terms: readonly string[]) {
  return {
    all: [
      { field: "source.type", op: "is", value: type },
      {
        any: terms.flatMap((term) => [
          { field: "title", op: "contains", value: term },
          { field: "body", op: "contains", value: term },
        ]),
      },
    ],
  };
}

function classifier(
  type: string,
  key: string,
  name: string,
  category: string,
  description: string,
  terms: readonly string[],
): StarterRule {
  return {
    key,
    name,
    description,
    type: "classifier",
    declares: [],
    draft: { classifier: name, when: wordsIn(type, terms), assign: [category] },
  };
}

/** The one Extractor Rule that suits every Source type: a version number in the title. */
function versionRule(type: string): StarterRule {
  return {
    key: "version",
    name: "Version",
    description: "Pulls a version number such as v1.2.3 out of an Item's title into a version field.",
    type: "extractor",
    declares: ["version"],
    draft: {
      extractor: "Version",
      when: { field: "source.type", op: "is", value: type },
      fields: [{ name: "version", type: "string", from: "title", regex: "(?i)\\bv(\\d+(?:\\.\\d+)+)\\b" }],
    },
  };
}

function contentStarters(type: string): StarterRule[] {
  return [
    classifier(
      type,
      "bug-reports",
      "Bug reports",
      "bug-report",
      "Sorts Items that mention a bug, a crash, an error or a regression into bug-report.",
      bugTerms,
    ),
    classifier(
      type,
      "feature-requests",
      "Feature requests",
      "feature-request",
      "Sorts Items that ask for a feature or a suggestion into feature-request.",
      featureTerms,
    ),
    versionRule(type),
  ];
}

function releaseStarters(type: string): StarterRule[] {
  return [
    classifier(
      type,
      "security-releases",
      "Security releases",
      "security",
      "Sorts Items that mention security, a vulnerability, a CVE or an advisory.",
      securityTerms,
    ),
    classifier(
      type,
      "breaking-changes",
      "Breaking changes",
      "breaking-change",
      "Sorts Items that announce a breaking change.",
      breakingTerms,
    ),
    versionRule(type),
  ];
}

/** The kind of GitHub Source, for the one Source type whose starters depend on its config. */
function githubKind(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null || !("kind" in config)) return undefined;
  return typeof config.kind === "string" ? config.kind : undefined;
}

/**
 * The starter rules to offer for a Source: two Classifiers and an Extractor Rule, scoped to its type
 * so they read as "Source type is rss" and cover every Source of that type, minus any whose name the
 * Workspace already uses and any Extractor Rule whose fields it already declares. A rule whose name
 * is taken would be refused on save, and a field another Extractor Rule declares is refused as well,
 * so hiding them leaves only the ones one click can create.
 */
export function starterRulesFor(source: StarterSource, context: StarterContext): StarterRule[] {
  const candidates = githubKind(source.config) === "releases" ? releaseStarters(source.type) : contentStarters(source.type);
  return candidates.filter(
    (rule) =>
      !context.existingNames[rule.type].includes(rule.name) &&
      rule.declares.every((field) => !context.declaredFields.includes(field)),
  );
}
