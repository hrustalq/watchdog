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
    await expect(page.getByRole("heading", { name: "Nothing is being watched yet" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  });
});
