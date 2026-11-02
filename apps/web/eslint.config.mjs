import { web } from "@watchdog/eslint-config/web";
import { defineConfig } from "eslint/config";

export default defineConfig([
  ...web(import.meta.dirname),

  // NEXT_RUNTIME is set by Next.js to pick the runtime, not configuration the loader owns.
  {
    files: ["src/instrumentation.ts"],
    rules: { "no-restricted-properties": "off" },
  },
]);
