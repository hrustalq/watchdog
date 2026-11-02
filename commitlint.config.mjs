// Conventional Commits, so release tooling can build versions and the changelog from history.
// Subjects stay lowercase (config-conventional's subject-case); see AGENTS.md.
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [2, "always", ["web", "worker", "core", "db", "docs", "deps", "ci", "release"]],
  },
};
