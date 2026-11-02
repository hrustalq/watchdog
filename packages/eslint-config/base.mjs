// The shared lint rules for every package. A package's eslint.config.mjs calls
// `base(import.meta.dirname)` and adds blocks for its own files.
import js from "@eslint/js";
import { recommended as comments } from "@eslint-community/eslint-plugin-eslint-comments/configs";
import vitest from "@vitest/eslint-plugin";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";
import { defineConfig, globalIgnores } from "eslint/config";
import { configs as ts } from "typescript-eslint";

/** @param {string} packageDir the directory holding the package's tsconfig.json */
export function base(packageDir) {
  return defineConfig([
    globalIgnores(["**/.next/**", "**/next-env.d.ts", "**/dist/**"]),

    {
      linterOptions: { reportUnusedDisableDirectives: "error" },
    },

    js.configs.recommended,
    ts.strictTypeChecked,
    ts.stylisticTypeChecked,
    comments,
    importX.flatConfigs.recommended,
    importX.flatConfigs.typescript,

    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir: packageDir },
      },
      settings: {
        "import-x/resolver-next": [createTypeScriptImportResolver({ project: `${packageDir}/tsconfig.json` })],
      },
      rules: {
        // No type casting: narrow with a type guard or a zod parse. `as const` stays allowed.
        // strictTypeChecked already bans @ts-ignore and @ts-expect-error without a description.
        "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],

        // Null and edge-case checks.
        "@typescript-eslint/strict-boolean-expressions": "error",
        "@typescript-eslint/switch-exhaustiveness-check": "error",

        // Promises and errors. `no-empty` (no empty catch) comes from js.configs.recommended.
        "@typescript-eslint/return-await": ["error", "in-try-catch"],

        // Escape hatches cost something.
        "@eslint-community/eslint-comments/require-description": "error",

        // No stubs or leftovers. Deferred work becomes an issue, not a comment.
        "no-warning-comments": "error",
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

        // Config comes in one way: the config loader in packages/core/src/config.ts.
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

    // JavaScript files (tool configs) have no type information to lint against.
    {
      files: ["**/*.{js,mjs,cjs}"],
      extends: [ts.disableTypeChecked],
    },

    // Tests and tool configs set up the environment they run in.
    {
      files: ["**/*.test.{ts,tsx}", "**/*.config.{ts,mts,mjs,js}"],
      rules: { "no-restricted-properties": "off" },
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
  ]);
}
