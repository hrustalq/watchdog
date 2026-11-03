import { base } from "@watchdog/eslint-config/base";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...base(import.meta.dirname),

  // The worker reports its lifecycle and failed polls on stdout and stderr; there is no logger yet.
  {
    files: ["src/index.ts", "src/scheduler.ts"],
    rules: { "no-console": "off" },
  },
]);
