import { defineConfig, devices } from "@playwright/test";

/**
 * Whether a run records a trace.
 *
 * Trace files are written by the browser into `test-results/.playwright-artifacts-<n>/traces`, and
 * every `playwright test` invocation begins by removing `test-results` (the runner's "clear output"
 * task). A second run in this project therefore deletes a live run's trace directory, and the ENOENT
 * that follows is thrown from `browserContext.close`, replacing the test's own error in the report.
 * CI runs the suite once, alone, and keeps the trace for the uploaded artifacts; a local run reports
 * the assertion instead. `SMOKE_TRACE=on` records a trace locally for a run that is alone.
 */
const trace = (): "retain-on-failure" | "off" => {
  if (process.env.SMOKE_TRACE === "on" || Boolean(process.env.CI)) return "retain-on-failure";
  return "off";
};

// Run through `pnpm smoke`, which starts the Compose stack the test signs in to.
export default defineConfig({
  testDir: "src",
  forbidOnly: true,
  // Above the two 15-second log reads, so a missing link fails with its own message.
  timeout: 60_000,
  // Most checks wait on a server round trip, and a loaded CI runner has stalled for several seconds.
  expect: { timeout: 15_000 },
  // The HTML report never opens by itself, so a failed run can't hang waiting on it.
  reporter: [["list"], ["html", { open: "never" }]],
  use: { trace: trace() },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
});
