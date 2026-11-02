// One flat config for the whole repo. Each package runs `eslint . --max-warnings 0`
// from its own directory, and ESLint finds this file by walking up.
import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import vitest from "@vitest/eslint-plugin";
import nextVitals from "eslint-config-next/core-web-vitals";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";
import jsxA11y from "eslint-plugin-jsx-a11y";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

const web = "apps/web";

// eslint-config-next applies to every file it sees, so scope it to the web app.
// Its `next/typescript` block and its parser are dropped: the type-aware typescript-eslint
// setup below parses every file, and type-aware rules need its parser.
const nextForWeb = nextVitals
  .filter((block) => block.name !== "next/typescript" && !(block.ignores && Object.keys(block).length === 1))
  .map(({ languageOptions: { parser: _parser, ...languageOptions } = {}, ...block }) => ({
    ...block,
    languageOptions,
    files: (block.files ?? ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"]).map((glob) => `${web}/${glob}`),
  }));

export default defineConfig([
  globalIgnores(["**/.next/**", "**/out/**", "**/build/**", "**/dist/**", "**/next-env.d.ts", "**/.turbo/**"]),

  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  comments.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    settings: {
      "import-x/resolver-next": [
        createTypeScriptImportResolver({ project: ["apps/*/tsconfig.json", "packages/*/tsconfig.json"] }),
      ],
    },
    rules: {
      // No type casting: narrow with a type guard or a zod parse. `as const` stays allowed.
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": "allow-with-description", "ts-ignore": true, "ts-nocheck": true },
      ],

      // Null and edge-case checks.
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",

      // Promises and errors.
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "no-empty": ["error", { allowEmptyCatch: false }],

      // Escape hatches cost something.
      "@eslint-community/eslint-comments/require-description": "error",

      // No stubs or leftovers. Deferred work becomes an issue, not a comment.
      "no-warning-comments": ["error", { terms: ["todo", "fixme", "xxx"] }],
      "no-console": "error",
      "no-alert": "error",
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true }],

      // Plainer code.
      eqeqeq: "error",
      "no-param-reassign": "error",
      "no-nested-ternary": "error",
      "no-else-return": "error",
      "no-implicit-coercion": "error",
      "@typescript-eslint/no-shadow": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",
      "no-restricted-syntax": [
        "error",
        { selector: "TSEnumDeclaration", message: "Use a union of string literals instead of an enum." },
      ],

      // Imports.
      "import-x/no-cycle": "error",
      "import-x/no-duplicates": "error",
      "import-x/no-extraneous-dependencies": "error",

      // Config comes in one way: the config loader.
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read configuration through the config loader in packages/core/src/config.ts.",
        },
      ],
    },
  },

  // JavaScript files have no type information to lint against.
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // The config loader is the one place that reads the environment; tests and tool configs set it up.
  {
    files: ["packages/core/src/config.ts", "**/*.test.{ts,tsx}", "**/*.config.{ts,mts,mjs,js}"],
    rules: { "no-restricted-properties": "off" },
  },

  // The worker's entry point reports its lifecycle on stdout; there is no logger yet.
  {
    files: ["apps/worker/src/index.ts"],
    rules: { "no-console": "off" },
  },

  // Tests mean something: no `.only`, no `.skip`, every test asserts.
  {
    files: ["**/*.test.{ts,tsx}"],
    extends: [vitest.configs.recommended],
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      "vitest/expect-expect": "error",
      "vitest/valid-title": "error",
    },
  },

  // Next.js, React and accessibility for the web app.
  ...nextForWeb,
  {
    files: [`${web}/**/*.{ts,tsx}`],
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      "react/jsx-no-leaked-render": "error",
      "react/no-array-index-key": "error",
      "react/no-unstable-nested-components": "error",
      "react/jsx-no-constructed-context-values": "error",
      "react/jsx-no-useless-fragment": "error",
      "react/button-has-type": "error",
      "react/no-danger": "error",
      "react/self-closing-comp": "error",
    },
  },
]);
