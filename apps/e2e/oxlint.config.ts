import { base } from "@watchdog/lint-config/base";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [base],
  // What a smoke run writes: the HTML report and the traces.
  ignorePatterns: ["playwright-report/", "test-results/"],
});
