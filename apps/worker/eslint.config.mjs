import { base } from "@watchdog/eslint-config/base";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...base(import.meta.dirname),

  // The worker reports its lifecycle and failed jobs on stdout and stderr; there is no logger yet.
  {
    files: ["src/index.ts", "src/scheduler.ts", "src/pipeline.ts", "src/delivery.ts"],
    rules: { "no-console": "off" },
  },
]);
