import { expect, test } from "@playwright/test";
import { magicLink, setupLink } from "./web-log.ts";

// The first test claims the install, and a test running beside it would race it for the setup link.
test.describe.configure({ mode: "serial" });

// A new self-hosted install with no mail server, end to end: claim it with the setup link, sign in
// with the magic link, land on the empty Workspace, add an RSS Source and see the worker's poll of
// it in the Feed. The feed is the recorded fixture the fixtures container serves
// (compose.smoke.yaml), with dates relative to the run.
test("a new install signs in, adds an RSS Source and sees its Items in the Feed", async ({ page }) => {
  // The Items wait for the worker's next tick, at most a minute, and the Feed's next refresh.
  test.setTimeout(240_000);
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
    // With no Items, Top has no order to describe.
    await expect(page.getByText("Rated Items captured")).toHaveCount(0);
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
        timeout: 150_000,
      });
    }
    // Captured in the same poll as the two above, so it would be on the page by now.
    await expect(item("E-Maj 5.0.1"), "an entry older than 7 days was captured").toHaveCount(0);
    // No model here, so Top shows Latest order and says why.
    await expect(page.getByText("this Workspace has no model")).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a model to rate new Items" })).toHaveAttribute("href", "/model");
  });

  await test.step("open an Item and see its capture Log row", async () => {
    await page.getByRole("link", { name: "Security release for psqlodbc" }).click();
    const log = page.getByRole("region", { name: "Log" }).getByRole("listitem");
    await expect(log.filter({ hasText: "capture" })).toContainText(
      "Captured from PostgreSQL news as part of the Backfill",
    );
  });
});

// What only a real browser on a real build shows of the Rules editor. It navigates by clicking,
// because a hard load remounts the page and hides what Next.js keeps across navigations (Activity).
// It runs before the rate limit test below, which uses up the sign-in bucket.
test("the Rules editor keeps a draft only where it should, with and without JavaScript", async ({ page, browser }) => {
  // Two log reads and a wait for hydration leave too little of the default for the rest on a slow runner.
  test.setTimeout(120_000);
  const email = "smoke@example.com";
  // A page a client navigation left behind is still in the DOM, hidden, with the same ids. So one
  // input can hold both pages' labels, and getByRole would read its name as "Name Name".
  const field = (label: string) => page.getByLabel(label, { exact: true }).locator("visible=true");
  const name = field("Name");
  const operator = field("Operator");
  const value = field("Value");
  const categories = field("Categories to assign");
  const yaml = field("Rule as YAML");
  const showForm = page.getByRole("button", { name: "Form", exact: true });
  const showYaml = page.getByRole("button", { name: "YAML", exact: true });
  const save = page.getByRole("button", { name: "Save rule" });
  const cancel = page.getByRole("link", { name: "Cancel" });
  const newRule = page.getByRole("link", { name: "New Deterministic Classifier" });
  const savedRule = page.getByRole("link", { name: "Security news", exact: true });
  const reason = /isn't a regular expression/;
  const reasonInList = page.getByRole("listitem").filter({ hasText: reason });

  await test.step("sign in again and open a new rule", async () => {
    await page.goto(new URL("/sign-in", await setupLink()).href);
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a sign-in link" }).click();
    await expect(page.getByRole("heading", { name: "Open the link from the server log" })).toBeVisible();
    await page.goto(await magicLink(email));
    await page.getByRole("button", { name: "Sign in to Watchdog" }).click();
    await page.getByRole("link", { name: "Rules", exact: true }).click();
    await newRule.click();
    // A click does nothing until React has hydrated the page. From here on, navigation is client-side.
    await expect(async () => {
      await showYaml.click();
      await expect(yaml).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await showForm.click();
  });

  await test.step("New is blank after a rule is saved", async () => {
    await name.fill("Security news");
    await value.fill("security");
    await categories.fill("security");
    await save.click();
    await expect(page.getByRole("status").filter({ hasText: "Rule saved." })).toBeVisible();
    await newRule.click();
    await expect(name).toHaveValue("");
    await expect(value).toHaveValue("");
    await expect(categories).toHaveValue("");
  });

  await test.step("Back restores a draft in progress, and New is blank after a Cancel", async () => {
    await name.fill("Half written");
    await cancel.click();
    await expect(newRule).toBeVisible();
    await page.goBack();
    await expect(name).toHaveValue("Half written");
    await cancel.click();
    await newRule.click();
    await expect(name).toHaveValue("");
    await cancel.click();
  });

  await test.step("a rule opened again shows its saved values, not an abandoned edit", async () => {
    await savedRule.click();
    await expect(name).toHaveValue("Security news");
    await name.fill("Abandoned edit");
    await cancel.click();
    await savedRule.click();
    await expect(name).toHaveValue("Security news");
    await cancel.click();
  });

  await test.step("a refused save keeps the Operator and moves focus to the first invalid control", async () => {
    await newRule.click();
    await name.fill("Refused");
    await operator.selectOption("matches");
    await value.fill("(");
    await categories.fill("launches");
    await save.click();
    await expect(value).toHaveAccessibleDescription(reason);
    await expect(operator).toHaveValue("matches");
    await expect(value).toBeFocused();
  });

  await test.step("the reason survives a trip to YAML and back, and an edit there drops it", async () => {
    await showYaml.click();
    await showForm.click();
    await expect(value).toHaveAccessibleDescription(reason);

    await showYaml.click();
    await yaml.fill((await yaml.inputValue()).replace("Refused", "Refused again"));
    await showForm.click();
    await expect(name).toHaveValue("Refused again");
    await expect(reasonInList).toHaveCount(0);
  });

  await test.step("the reason for YAML with a comment survives the trip too", async () => {
    await showYaml.click();
    await yaml.fill(`# The view rewrites this text on the way back.\n${await yaml.inputValue()}`);
    await save.click();
    await expect(reasonInList).toBeVisible();
    await showForm.click();
    await showYaml.click();
    await showForm.click();
    await expect(value).toHaveAccessibleDescription(reason);
    await cancel.click();
  });

  await test.step("without JavaScript, the YAML box refuses, keeps the draft, and saves", async () => {
    const rule = (pattern: string) =>
      `classifier: Written without JavaScript\nwhen:\n  field: title\n  op: matches\n  value: "${pattern}"\nassign:\n  - launches\n`;
    const context = await browser.newContext({
      javaScriptEnabled: false,
      storageState: await page.context().storageState(),
    });
    const noScript = await context.newPage();
    await noScript.goto(new URL("/rules/new", page.url()).href);
    const box = noScript.getByLabel("Rule as YAML");
    await box.fill(rule("("));
    await noScript.getByRole("button", { name: "Save rule" }).click();
    await expect(noScript).toHaveURL(/[?&]draft=/);
    await expect(box).toHaveValue(rule("("));
    // Not the page's HTML, which holds the reason in React's data even when nothing shows it.
    await expect(box).toHaveAccessibleDescription(reason);

    await box.fill(rule("(?i)launch"));
    await noScript.getByRole("button", { name: "Save rule" }).click();
    await expect(noScript).toHaveURL(/\/rules\?saved=1$/);
    await context.close();

    await page.goto(new URL("/rules", page.url()).href);
    await expect(page.getByRole("link", { name: "Written without JavaScript" })).toBeVisible();
  });
});

// Better Auth keys the sign-in rate limit (5 a minute) on X-Forwarded-For. Caddy sets that header
// from the connection, so a new value on every request still lands in this machine's one bucket.
// The tests above may have used part of the bucket, so the limit comes at the sixth request or before.
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
