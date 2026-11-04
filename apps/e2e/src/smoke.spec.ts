import { expect, test } from "@playwright/test";
import { magicLink, setupLink } from "./web-log.ts";

// A new self-hosted install with no mail server, end to end: claim it with the setup link, sign in
// with the magic link, land on the empty Workspace, add an RSS Source and see the worker's poll of
// it in the Feed. The feed is the recorded fixture the fixtures container serves
// (compose.smoke.yaml), with dates relative to the run.
test("a new install signs in, adds an RSS Source and sees its Items in the Feed", async ({ page }) => {
  // The Items wait for the worker's next tick, at most a minute, and the Feed's next refresh.
  test.setTimeout(180_000);
  const email = "smoke@example.com";

  await test.step("claim the install with the setup link", async () => {
    await page.goto(await setupLink());
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("heading", { name: "Open the link from the server log" })).toBeVisible();
  });

  await test.step("sign in with the magic link", async () => {
    await page.goto(await magicLink(email));
    await page.getByRole("button", { name: "Sign in to Watchdog" }).click();
    await expect(page.getByRole("heading", { name: "Nothing is being watched yet" })).toBeVisible();
  });

  await test.step("add the fixture feed as an RSS Source", async () => {
    await page.getByRole("link", { name: "Add a Source" }).click();
    // The page shows a copy of the form until the streamed one replaces it, and that drops what
    // was typed into the copy, so the browser refuses the empty field. A repeat after a submit that
    // went through says the feed is already watched, so a retry can't hide a failure.
    await expect(async () => {
      await page.getByLabel("RSS feed URL").fill("http://fixtures/feed.xml");
      await page.getByRole("button", { name: "Add Source" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Source added." })).toBeVisible({
        timeout: 10_000,
      });
    }).toPass({ timeout: 30_000 });
  });

  const item = (title: string) => page.getByRole("listitem").filter({ hasText: title });
  await test.step("see the feed's recent entries in the Feed as the Backfill", async () => {
    await page.getByRole("link", { name: "Workspace" }).click();
    // The Feed refreshes itself every 30 seconds, so no reload is needed.
    for (const title of ["Security release for psqlodbc", "HypoPG 1.4.5 is out!"]) {
      await expect(item(title), `"${title}" never reached the Feed`).toContainText("Backfill", {
        timeout: 120_000,
      });
    }
    // Captured in the same poll as the two above, so it would be on the page by now.
    await expect(item("E-Maj 5.0.1"), "an entry older than 7 days was captured").toHaveCount(0);
  });

  await test.step("open an Item and see its capture Log row", async () => {
    await page.getByRole("link", { name: "Security release for psqlodbc" }).click();
    const log = page.getByRole("region", { name: "Log" }).getByRole("listitem");
    await expect(log.filter({ hasText: "capture" })).toContainText(
      "Captured from PostgreSQL news as part of the Backfill",
    );
  });
});

// Better Auth keys the sign-in rate limit (5 a minute) on X-Forwarded-For. Caddy sets that header
// from the connection, so a new value on every request still lands in this machine's one bucket.
// The test above already used part of the bucket, so the limit comes at the sixth request or before.
test("a spoofed X-Forwarded-For doesn't escape the sign-in rate limit", async ({ page }) => {
  const signIn = new URL("/sign-in", await setupLink()).href;
  for (let i = 1; i <= 6 && !page.url().includes("error=too-many"); i++) {
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": `203.0.113.${String(i)}` });
    await page.goto(signIn);
    await page.getByLabel("Email").fill("someone-else@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page).toHaveURL(/\/sign-in\/check-email|error=too-many/);
  }
  await expect(page, "six requests with six X-Forwarded-For values all went through").toHaveURL(/error=too-many/);
});
