import { base } from "@watchdog/eslint-config/base";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...base(import.meta.dirname),

  // The entry point reports the worker's lifecycle on stdout; there is no logger yet.
  {
    files: ["src/index.ts"],
    rules: { "no-console": "off" },
  },
]);
