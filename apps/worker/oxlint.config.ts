import { base } from "@watchdog/lint-config/base";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [base],
  overrides: [
    // The worker reports its lifecycle and failed jobs on stdout and stderr; there is no logger yet.
    {
      files: ["src/index.ts", "src/scheduler.ts", "src/pipeline.ts", "src/delivery.ts"],
      rules: { "no-console": "off" },
    },
  ],
});
