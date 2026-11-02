import { base } from "@watchdog/eslint-config/base";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...base(import.meta.dirname),

  // The config loader is the one place that reads the environment.
  {
    files: ["src/config.ts"],
    rules: { "no-restricted-properties": "off", "no-restricted-imports": "off" },
  },
]);
