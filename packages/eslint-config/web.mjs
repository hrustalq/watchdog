// The base rules plus Next.js, React and accessibility, for apps/web.
import nextVitals from "eslint-config-next/core-web-vitals";
import jsxA11y from "eslint-plugin-jsx-a11y";
import { defineConfig } from "eslint/config";
import { base } from "./base.mjs";

// The `next/typescript` block and Next's parser are dropped: the type-aware
// typescript-eslint setup in base parses every file, and type-aware rules need its parser.
const next = nextVitals
  .filter((block) => block.name !== "next/typescript")
  .map(({ languageOptions: { parser: _parser, ...languageOptions } = {}, ...block }) => ({
    ...block,
    languageOptions,
  }));

/** @param {string} packageDir the directory holding the app's tsconfig.json */
export function web(packageDir) {
  return defineConfig([
    ...base(packageDir),
    ...next,
    {
      files: ["**/*.{ts,tsx}"],
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
}
