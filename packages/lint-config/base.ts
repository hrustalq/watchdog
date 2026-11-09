// The shared lint rules for every package. A package's oxlint.config.ts extends `base` and adds
// overrides for its own files.
import { fileURLToPath } from "node:url";
import { defineConfig } from "oxlint";
import { javascriptFiles, recommended, typescriptFiles, vitestRecommended } from "./presets.ts";

const envMessage = "Read configuration through the config loader in packages/core/src/config.ts.";

// A JS plugin path in a shared config would resolve against the package that extends it, which
// doesn't depend on the plugin, so each one is resolved here, from this package.
const plugin = (name: string) => fileURLToPath(import.meta.resolve(name));

export const base = defineConfig({
  plugins: ["eslint", "typescript", "import", "vitest"],
  jsPlugins: [
    plugin("@eslint-community/eslint-plugin-eslint-comments"),
    // oxlint reserves the import-x name for its native import rules.
    { name: "import-x-js", specifier: plugin("eslint-plugin-import-x") },
  ],
  // Only the rules listed here and in presets.ts run, not oxlint's default set.
  categories: { correctness: "off" },
  options: {
    typeAware: true,
    // A warning fails lint like an error.
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
  },
  env: { builtin: true },
  ignorePatterns: ["**/.next/**", "**/next-env.d.ts", "**/dist/**"],

  rules: {
    ...recommended,

    // No type casting: narrow with a type guard or a zod parse. `as const` stays allowed.
    // strict-type-checked already bans @ts-ignore and @ts-expect-error without a description.
    "typescript/consistent-type-assertions": ["error", { assertionStyle: "never" }],

    // Null and edge-case checks.
    "typescript/strict-boolean-expressions": "error",
    "typescript/switch-exhaustiveness-check": "error",

    // Promises and errors. `no-empty` (no empty catch) comes from the recommended rules.
    "typescript/return-await": ["error", "in-try-catch"],

    // Escape hatches cost something.
    "@eslint-community/eslint-comments/require-description": "error",

    // No stubs or leftovers. Deferred work becomes an issue, not a comment.
    "no-warning-comments": "error",
    "no-console": "error",
    "no-alert": "error",
    "no-unused-vars": ["error", { ignoreRestSiblings: true }],

    // Plainer code. TypeScript's erasableSyntaxOnly already rejects enums.
    eqeqeq: "error",
    "no-param-reassign": "error",
    "no-nested-ternary": "error",
    "no-else-return": "error",
    "no-implicit-coercion": "error",
    "no-shadow": "error",
    "typescript/consistent-type-imports": "error",
    "typescript/no-import-type-side-effects": "error",

    // Imports. oxlint has no no-extraneous-dependencies, so import-x runs it as a JS plugin.
    "import/no-cycle": "error",
    "import/no-duplicates": "error",
    "import-x-js/no-extraneous-dependencies": "error",

    // Config comes in one way: the config loader in packages/core/src/config.ts (#3).
    "no-restricted-properties": ["error", { object: "process", property: "env", message: envMessage }],
    "no-restricted-imports": [
      "error",
      { name: "node:process", importNames: ["env"], message: envMessage },
      { name: "process", importNames: ["env"], message: envMessage },
    ],
  },

  overrides: [
    { files: ["**/*.{ts,tsx,mts,cts}"], rules: typescriptFiles },

    // JavaScript files (tool configs and fixtures) have no type information to lint against.
    { files: ["**/*.{js,mjs,cjs}"], rules: javascriptFiles },

    // Tests and tool configs set up the environment they run in.
    {
      files: ["**/*.test.{ts,tsx}", "**/*.config.{ts,mts,mjs,js}"],
      rules: { "no-restricted-properties": "off", "no-restricted-imports": "off" },
    },

    // Tests mean something: no `.only`, no `.skip`, every test asserts.
    {
      files: ["**/*.test.{ts,tsx}"],
      rules: {
        ...vitestRecommended,
        "vitest/no-focused-tests": "error",
        "vitest/no-disabled-tests": "error",
        "vitest/expect-expect": "error",
        "vitest/valid-title": "error",
      },
    },
  ],
});
