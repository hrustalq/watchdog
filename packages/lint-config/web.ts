// The base rules plus Next.js, React and accessibility, for apps/web.
import { defineConfig } from "oxlint";
import { base } from "./base.ts";
import { a11yStrict, next, nextReact } from "./presets.ts";

export const web = defineConfig({
  extends: [base],
  plugins: ["eslint", "typescript", "import", "vitest", "nextjs", "react", "jsx-a11y"],
  rules: {
    ...next,
    ...nextReact,
  },
  overrides: [
    {
      files: ["**/*.{ts,tsx}"],
      rules: {
        ...a11yStrict,
        // react/jsx-no-leaked-render isn't in oxlint. strict-boolean-expressions in base rejects
        // the `count && <X />` it would catch.
        "react/no-array-index-key": "error",
        "react/no-unstable-nested-components": "error",
        "react/jsx-no-constructed-context-values": "error",
        "react/jsx-no-useless-fragment": "error",
        "react/button-has-type": "error",
        "react/no-danger": "error",
        "react/self-closing-comp": "error",
      },
    },
  ],
});
