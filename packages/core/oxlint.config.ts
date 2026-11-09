import { base } from "@watchdog/lint-config/base";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [base],
  overrides: [
    // The config loader is the one place that reads the environment.
    {
      files: ["src/config.ts"],
      rules: { "no-restricted-properties": "off", "no-restricted-imports": "off" },
    },
  ],
});
