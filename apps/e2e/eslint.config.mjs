import { base } from "@watchdog/eslint-config/base";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  ...base(import.meta.dirname),

  // What a smoke run writes: the HTML report and the traces.
  globalIgnores(["playwright-report/", "test-results/"]),
]);
