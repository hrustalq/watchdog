import { expect, test } from "@playwright/test";
import { magicLink, setupLink } from "./web-log.ts";

// A new self-hosted install with no mail server, end to end: claim it with the setup link, sign in
// with the magic link, land on the empty Workspace. M1 adds steps for adding an RSS Source and
// seeing its Item in the Feed.
test("a new install signs in to an empty Workspace", async ({ page }) => {
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
});

// Better Auth keys the sign-in rate limit (5 a minute) on X-Forwarded-For. Caddy sets that header
// from the connection, so a new value on every request still lands in this machine's one bucket.
// The test above already used part of the bucket, so the limit comes at the sixth request or before.
test("a spoofed X-Forwarded-For doesn't escape the sign-in rate limit", async ({ page }) => {
  const signIn = new URL("/sign-in", await setupLink()).href;
  for (let i = 1; i <= 6; i++) {
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": `203.0.113.${String(i)}` });
    await page.goto(signIn);
    await page.getByLabel("Email").fill("someone-else@example.com");
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await page.waitForURL(/\/sign-in\/check-email|error=/);
    if (page.url().includes("error=too-many")) return;
  }
  throw new Error("Six sign-in requests with six X-Forwarded-For values all went through");
});
