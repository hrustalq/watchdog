import { defineConfig, devices } from "@playwright/test";

// Run through `pnpm smoke`, which starts the Compose stack the test signs in to.
export default defineConfig({
  testDir: "src",
  forbidOnly: true,
  // The HTML report never opens by itself, so a failed run can't hang waiting on it.
  reporter: [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: devices["Desktop Chrome"] }],
});
