import { web } from "@watchdog/lint-config/web";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [web],
  overrides: [
    // NEXT_RUNTIME is set by Next.js to pick the runtime, not configuration the loader owns.
    {
      files: ["src/instrumentation.ts"],
      rules: { "no-restricted-properties": "off" },
    },
  ],
});
