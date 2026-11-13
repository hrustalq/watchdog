import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  botMessages,
  confirmationLink,
  fixtureFeed,
  fixturePage,
  flipFixtureSite,
  magicLink,
  publishEntry,
  sendToBot,
  setupLink,
  workerMailsTo,
} from "./stack.ts";

// The first test claims the install, and a test running beside it would race it for the setup link.
test.describe.configure({ mode: "serial" });

const email = "smoke@example.com";

// A new Source's Items wait for the worker's next tick, at most a minute, and the Feed's next refresh.
const untilPolled = { timeout: 150_000 };

// A page a client navigation left behind is still in the DOM, hidden, with the same ids. So one
// input can hold both pages' labels, and getByRole would read its name as "Name Name".
const visibleField = (page: Page, label: string) => page.getByLabel(label, { exact: true }).locator("visible=true");

const feedRow = (page: Page, title: string) => page.getByRole("listitem").filter({ hasText: title });

const itemLog = (page: Page) => page.getByRole("region", { name: "Log" }).getByRole("listitem");

/** Signs in to the install the first test claimed, because each test starts with a new browser context. */
async function signInAgain(page: Page) {
  await page.goto(new URL("/sign-in", await setupLink()).href);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByRole("heading", { name: "Open the link from the server log" })).toBeVisible();
  await page.goto(await magicLink(email));
  await page.getByRole("button", { name: "Sign in to Watchdog" }).click();
}

/** On a rule editor that just loaded, waits until it responds, and leaves it in the Form view. */
async function waitForEditor(page: Page) {
  // A click does nothing until React has hydrated the page. From here on, navigation is client-side.
  await expect(async () => {
    await page.getByRole("button", { name: "YAML", exact: true }).click();
    await expect(visibleField(page, "Rule as YAML")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Form", exact: true }).click();
}

/** From the Workspace, opens a new Classifier in the Form view. */
async function openNewClassifier(page: Page, kind: "Deterministic" | "Agent-backed") {
  await page.getByRole("link", { name: "Rules", exact: true }).click();
  await page.getByRole("link", { name: `New ${kind} Classifier` }).click();
  await waitForEditor(page);
}

/** On the Destinations screen, adds one named `name` through the form under `opener`. */
async function addDestination(page: Page, opener: string, submit: string, name: string, fields: Record<string, string> = {}) {
  await page.goto(new URL("/destinations", page.url()).href);
  const form = page.locator("details", { has: page.locator("summary", { hasText: opener }) });
  // As on Sources, the streamed form replaces the first copy, and that drops what was typed.
  await expect(async () => {
    if ((await form.getAttribute("open")) === null) await form.locator("summary").click();
    for (const [label, value] of Object.entries({ Name: name, ...fields })) {
      await form.getByLabel(label, { exact: true }).fill(value);
    }
    await form.getByRole("button", { name: submit }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 30_000 });
}

async function saveRule(page: Page) {
  await page.getByRole("button", { name: "Save rule" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Rule saved." })).toBeVisible();
}

/** On the Sources screen, adds a feed from the fixtures container (compose.smoke.yaml). */
async function addRssSource(page: Page, path: string) {
  const url = fixtureFeed(path);
  // The page shows a copy of the form until the streamed one replaces it, and that drops what
  // was typed into the copy, so the server refuses the empty field. A repeat after a submit that
  // went through says the feed is already watched, so a retry can't hide a failure.
  await expect(async () => {
    await visibleField(page, "RSS feed URL").fill(url);
    await page.getByRole("button", { name: "Add Source" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Source added." })).toBeVisible({
      timeout: 10_000,
    });
  }).toPass({ timeout: 30_000 });
  // The notice could be left over from the Source before this one, and the list can't.
  await expect(page.getByText(url, { exact: true })).toBeVisible();
}

/**
 * On the Sources screen, asks for a poll of the fixture feed's Source with Check now, so a test doesn't
 * wait out its schedule, and waits until the worker's tick has started it, within a minute. A click the
 * tick answers before the page says a poll is due is clicked again, and the second poll finds nothing new.
 */
async function checkNow(page: Page, path: string) {
  await page.goto(new URL("/sources", page.url()).href);
  const row = page.getByRole("listitem").filter({ hasText: fixtureFeed(path) });
  const due = row.getByRole("status").filter({ hasText: "A poll is due" });
  await expect(row.getByText("Health: ok", { exact: true })).toBeAttached();
  await expect(async () => {
    await row.getByRole("button", { name: /^Check now/ }).click();
    await expect(due).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(due, "the worker never took the poll").toHaveCount(0, untilPolled);
}

/**
 * The Sources screen's row for the Source named `name`. The name is matched on the row's heading, which
 * is the Source's own name, rather than on any of its text, where another row's URL could match too.
 */
const sourceRow = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ has: page.getByRole("heading", { name, level: 3, exact: true }) });

/** One field of the Add a Source form: the label it shows, or `#id` where two fields share a label. */
type FormField = readonly [label: string, value: string];

/**
 * Submits an Add a Source form. The server action redirects as it answers, so the click can throw on a
 * page that navigated under it although it went through; what the page shows next says whether it did,
 * and that is what the caller checks.
 */
async function submitAdd(form: Locator) {
  await form
    .getByRole("button", { name: "Add Source" })
    .click({ timeout: 10_000 })
    .catch(() => undefined);
}

/**
 * On the Sources screen, adds a Source of `type` (the form radio's value), reading the page the way
 * `render` names (`static`, `obscura` or `chromium`) where it watches a website, and leaving the page
 * on the Source's own "Source added." notice.
 *
 * A click that lands before React has hydrated the page changes nothing: the streamed form replaces the
 * copy drawn before it, and the choice and the typed values go with it. So each step is checked in the
 * form that has the choice, and a step that didn't stick is tried again. A fresh load first clears the
 * notice the Source before it left, which a retry would otherwise take for this one's.
 */
async function addSource(page: Page, type: string, fields: FormField[], render?: string) {
  await page.goto(new URL("/sources", page.url()).href);
  await expect(async () => {
    await page.locator(`label:has(#type-${type}):visible`).click({ timeout: 5_000 });
    await expect(page.locator(`#type-${type}:checked`)).toHaveCount(1, { timeout: 5_000 });
    const form = page.locator(`form:has(#type-${type}:checked)`).first();
    if (render !== undefined) {
      await form.locator(`label:has(#render-${render})`).click({ timeout: 5_000 });
      await expect(form.locator(`#render-${render}:checked`)).toHaveCount(1, { timeout: 5_000 });
    }
    for (const [label, value] of fields) {
      const field = label.startsWith("#") ? form.locator(label) : form.getByLabel(label, { exact: true });
      await field.fill(value, { timeout: 5_000 });
      await expect(field).toHaveValue(value, { timeout: 5_000 });
    }
    await submitAdd(form);
    await expect(page.getByRole("status").filter({ hasText: "Source added." })).toBeVisible({ timeout: 15_000 });
  }).toPass({ timeout: 120_000 });
}

/**
 * Waits until the Source named `name` has polled successfully, which is what stores a website Source's
 * Baseline. Its Health says ok before its first poll, so the row's last success is what says it polled.
 */
async function waitForFirstPoll(page: Page, name: string) {
  await expect(async () => {
    await page.goto(new URL("/sources", page.url()).href);
    const row = sourceRow(page, name);
    await expect(row.getByText(/Last success/), `${name} never polled successfully`).toBeAttached({ timeout: 2_000 });
  }).toPass({ timeout: 240_000 });
}

/** Asks for a poll of the Source named `name` with Check now, and waits for the worker to take it. */
async function checkSourceNow(page: Page, name: string) {
  await page.goto(new URL("/sources", page.url()).href);
  const row = sourceRow(page, name);
  const due = row.getByRole("status").filter({ hasText: "A poll is due" });
  await expect(async () => {
    await row.getByRole("button", { name: /^Check now/ }).click();
    await expect(due).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  await expect(due, "the worker never took the poll").toHaveCount(0, untilPolled);
}

/** Opens the Feed row titled `title` at its link's address, because a click while rows settle does nothing. */
async function openFeedItem(page: Page, title: string) {
  const link = page.getByRole("link", { name: title });
  await expect(link).toHaveAttribute("href", /^\/items\//, untilPolled);
  await page.goto(new URL((await link.getAttribute("href")) ?? "", page.url()).href);
}

// A new self-hosted install with no mail server, end to end: claim it with the setup link, sign in
// with the magic link, land on the empty Workspace, save a Classifier, add an RSS Source and see the
// worker's poll of it in the Feed, classified and unrated because there's no model. The feed is the
// recorded fixture the fixtures container serves (compose.smoke.yaml), with dates relative to the run.
test("a new install with no model classifies its first RSS Source's Items and leaves them unrated", async ({ page }) => {
  test.setTimeout(240_000);
  const other = "HypoPG 1.4.5 is out!";
  const release = "Security release for psqlodbc";

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

  await test.step("save a Deterministic Classifier", async () => {
    await openNewClassifier(page, "Deterministic");
    await visibleField(page, "Name").fill("Release news");
    await visibleField(page, "Value").fill("release");
    await visibleField(page, "Categories to assign").fill("release");
    await saveRule(page);
    await page.getByRole("link", { name: "Workspace" }).click();
  });

  await test.step("add the fixture feed as an RSS Source", async () => {
    await page.getByRole("link", { name: "Add a Source" }).click();
    await addRssSource(page, "feed.xml");
  });

  await test.step("see the feed's recent entries in the Feed as the Backfill", async () => {
    await page.getByRole("link", { name: "Workspace" }).click();
    // The Feed refreshes itself every 30 seconds, so no reload is needed.
    for (const title of [release, other]) {
      await expect(feedRow(page, title), `"${title}" never reached the Feed`).toContainText("Backfill", untilPolled);
    }
    // Captured in the same poll as the two above, so it would be on the page by now.
    await expect(feedRow(page, "E-Maj 5.0.1"), "an entry older than 7 days was captured").toHaveCount(0);
    // No model here, so Top shows Latest order and says why.
    await expect(page.getByText("this Workspace has no model")).toBeVisible();
    await expect(page.getByRole("link", { name: "Add a model to rate new Items" })).toHaveAttribute("href", "/model");
  });

  await test.step("the Classifier sorts the Items, and they stay unrated", async () => {
    await expect(feedRow(page, release).getByRole("list", { name: "Categories" })).toHaveText("release", untilPolled);
    await expect(feedRow(page, release)).toContainText("Unrated");
    await expect(feedRow(page, other)).toContainText("Unrated");
  });

  const log = itemLog(page);
  await test.step("open an Item and see its Log", async () => {
    await page.getByRole("link", { name: release }).click();
    await expect(log.filter({ hasText: "capture" })).toContainText(
      "Captured from PostgreSQL news as part of the Backfill",
    );
    await expect(log.filter({ hasText: "classify" })).toContainText("Classifier Release news assigned release");
    await expect(log.filter({ hasText: "Not rated" })).toContainText("this Workspace had no model to rate it with");
  });

  await test.step("an Item that doesn't meet the Condition gets no Category", async () => {
    await page.getByRole("link", { name: "Feed", exact: true }).click();
    await page.getByRole("link", { name: other }).click();
    // The rate row is the last of a run, so by then the classify row would be there. Its text says
    // "release", and the Classifier tests only the title.
    await expect(log.filter({ hasText: "Not rated" })).toBeVisible();
    await expect(log.filter({ hasText: "classify" })).toHaveCount(0);
  });
});

// What only a real browser on a real build shows of the Rules editor. It navigates by clicking,
// because a hard load remounts the page and hides what Next.js keeps across navigations (Activity).
// It runs before the rate limit test below, which uses up the sign-in bucket.
test("the Rules editor keeps a draft only where it should, with and without JavaScript", async ({ page, browser }) => {
  // Log reads and waits for hydration leave too little of the default for the rest on a slow runner.
  test.setTimeout(240_000);
  const field = (label: string) => visibleField(page, label);
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
    await signInAgain(page);
    await openNewClassifier(page, "Deterministic");
  });

  await test.step("New is blank after a rule is saved", async () => {
    await name.fill("Security news");
    await value.fill("security");
    await categories.fill("security");
    await saveRule(page);
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

  const inbox = page.getByRole("checkbox", { name: /^Smoke inbox/ });
  const elsewhere = page.getByRole("checkbox", { name: /^Other inbox/ });
  const hook = page.getByRole("checkbox", { name: /^Smoke hook/ });
  const kind = field("Kind");
  const newAction = page.getByRole("link", { name: "New Action" });
  const savedAction = page.getByRole("link", { name: "Severe alerts", exact: true });

  await test.step("an Action's form and YAML views edit one draft, and it saves", async () => {
    await addDestination(page, "Email address", "Add email address", "Smoke inbox", { Address: email });
    await addDestination(page, "Email address", "Add email address", "Other inbox", { Address: "other@example.com" });
    await addDestination(page, "Webhook URL", "Add webhook", "Smoke hook", { URL: "http://fixtures/hook" });
    await page.goto(new URL("/rules", page.url()).href);
    await newAction.click();
    await waitForEditor(page);

    await name.fill("Half written Action");
    await field("Field").selectOption("severity");
    await expect(operator).toHaveValue("gte");
    await value.fill("4");
    await inbox.check();
    await showYaml.click();
    await expect(yaml).toHaveValue(/field: severity\n\s+op: gte\n\s+value: 4\n/);
    await expect(yaml).toHaveValue(/destinations:\n\s+- Smoke inbox\n/);
    await yaml.fill((await yaml.inputValue()).replace("Half written Action", "Severe alerts"));
    await showForm.click();
    await expect(name).toHaveValue("Severe alerts");
    await expect(inbox).toBeChecked();
    await saveRule(page);
    await expect(page.getByText("Severity is at least 4", { exact: true }).locator("visible=true")).toBeVisible();
    await expect(page.getByText("To Smoke inbox", { exact: true }).locator("visible=true")).toBeVisible();
  });

  await test.step("New is blank after an Action is saved, and an opened one shows its saved values", async () => {
    await newAction.click();
    await expect(name).toHaveValue("");
    await expect(inbox).not.toBeChecked();
    await cancel.click();
    await savedAction.click();
    await expect(name).toHaveValue("Severe alerts");
    await name.fill("Abandoned edit");
    await cancel.click();
    await savedAction.click();
    await expect(name).toHaveValue("Severe alerts");
    await expect(field("Field")).toHaveValue("severity");
    await cancel.click();
  });

  await test.step("the form offers only the Destinations the kind allows, and the YAML can't sneak one in", async () => {
    await newAction.click();
    await expect(hook).toHaveCount(0);
    await kind.selectOption("webhook");
    await expect(hook).toBeVisible();
    await expect(inbox).toHaveCount(0);

    await name.fill("Wrong Destination");
    await value.fill("launch");
    await showYaml.click();
    await yaml.fill((await yaml.inputValue()).replace("destinations: []", "destinations:\n  - Smoke inbox"));
    await save.click();
    await expect(page.getByRole("listitem").filter({ hasText: "“Smoke inbox” isn't one" })).toBeVisible();
    await showForm.click();
    await expect(inbox).toBeChecked();
    await expect(inbox).toHaveAccessibleDescription(/“Smoke inbox” isn't one/);
    await cancel.click();
  });

  await test.step("a Digest with no schedule is refused beside the field, and an unconfirmed Destination gets a notice", async () => {
    const schedule = field("Schedule");
    const waiting = page.getByText(/Won't deliver to Other inbox until it's confirmed\./).locator("visible=true");
    await newAction.click();
    await kind.selectOption("digest");
    await name.fill("Weekly");
    await value.fill("launch");
    await elsewhere.check();
    await expect(waiting).toBeVisible();
    await save.click();
    await expect(schedule).toHaveAccessibleDescription(/can't be blank/);
    await expect(schedule).toBeFocused();
    await schedule.fill("0 9 * * 1");
    await saveRule(page);
    await expect(waiting).toBeVisible();
  });

  await test.step("the switch disables an Action, so the later tests' Items fire nothing", async () => {
    for (const action of ["Severe alerts", "Weekly"]) {
      const on = page.getByRole("switch", { name: new RegExp(`^${action}:`) });
      await on.click();
      await expect(on).toHaveAttribute("aria-checked", "false");
    }
  });
});

// The M2 demo: Items get Categories and a Rating, and a Correction changes later Ratings. The model is
// the fake-llm container (compose.smoke.yaml), which rates an Item Importance 2 unless the prompt holds
// a Correction that raised a similar Item. It runs before the rate limit test below, which uses up the
// sign-in bucket.
test("a Correction changes the Rating the Agent gives a later, similar Item", async ({ page }) => {
  // Two new Sources, each waiting for the worker's tick and the Feed's refresh.
  test.setTimeout(480_000);
  const corrected = "Acme launches a hosted query planner";
  const meetup = "Acme summer meetup recap";
  const similar = "Acme hosted query planner reaches general availability";
  const unrelated = "Acme opens a Lisbon office";
  const category = "competitor-launch";
  const log = itemLog(page);

  await test.step("add a model that points at fake-llm, and it answers a test", async () => {
    await signInAgain(page);
    await page.getByRole("link", { name: "Model", exact: true }).click();
    await visibleField(page, "Base URL").fill("http://fake-llm:8080/v1");
    await visibleField(page, "Model name").fill("fake-model");
    await page.getByRole("button", { name: "Save model" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Model saved." })).toBeVisible();
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Connected. fake-model answered." })).toBeVisible();
    await page.getByRole("link", { name: "Workspace" }).click();
  });

  await test.step("save an Agent-backed Classifier", async () => {
    await openNewClassifier(page, "Agent-backed");
    await visibleField(page, "Name").fill("Launch watch");
    await visibleField(page, "Prompt").fill("Does this Item announce a competitor's launch?");
    await visibleField(page, "Categories the Agent may assign").fill(category);
    await saveRule(page);
    await page.getByRole("link", { name: "Workspace" }).click();
  });

  await test.step("a new Source's Backfill Items gain Categories and Importance 2", async () => {
    await page.getByRole("link", { name: "Sources", exact: true }).click();
    await addRssSource(page, "before-correction.xml");
    await page.getByRole("link", { name: "Workspace" }).click();
    for (const title of [corrected, meetup]) {
      await expect(feedRow(page, title), `"${title}" was never rated 2`).toContainText("Importance 2 of 5", untilPolled);
      await expect(feedRow(page, title)).toContainText("Backfill");
      // Not the only one: the Rules test's Classifiers are still on.
      await expect(feedRow(page, title).getByRole("list", { name: "Categories" })).toContainText(category);
    }
  });

  await test.step("the Item shows its summary, and the Log has the reasoning", async () => {
    await page.getByRole("link", { name: corrected }).click();
    await expect(page.getByRole("region", { name: "Summary" })).toContainText(`The fake model's summary of "${corrected}"`);
    await expect(log.filter({ hasText: "The Agent classified" })).toContainText(`Launch watch assigned ${category}`);
    await expect(log.filter({ hasText: "The Agent rated" })).toContainText(
      "The Agent rated this Item Severity 1, Importance 2: No Correction raised a similar Item.",
    );
  });

  await test.step("correct the Item's Importance to 5", async () => {
    await page.getByRole("button", { name: /^Set Importance to 5 of 5/ }).click();
    await expect(log.filter({ hasText: "Corrected the Rating" })).toContainText(
      "Corrected the Rating from Severity 1, Importance 2 to Severity 1, Importance 5",
    );
    await page.getByRole("link", { name: "Feed", exact: true }).click();
  });

  await test.step("a second Source's similar Item is rated Importance 5 and leads Top", async () => {
    await page.getByRole("link", { name: "Sources", exact: true }).click();
    await addRssSource(page, "after-correction.xml");
    await page.getByRole("link", { name: "Workspace" }).click();
    await expect(feedRow(page, similar), "the Correction didn't reach the similar Item").toContainText(
      "Importance 5 of 5",
      untilPolled,
    );
    await expect(feedRow(page, unrelated), "the fake model took an unrelated Item for a similar one").toContainText(
      "Importance 2 of 5",
      untilPolled,
    );
    await expect(feedRow(page, corrected)).toContainText("Importance 5 of 5");
    // Level with the corrected Item, and captured after it.
    const rows = page.getByRole("heading", { level: 2 });
    await expect(rows.first()).toHaveText(similar);
    await expect(rows.nth(1)).toHaveText(corrected);
  });

  await test.step("Usage shows the calls", async () => {
    await page.getByRole("link", { name: "Usage", exact: true }).click();
    const purposes = page.getByRole("region", { name: "By purpose" });
    // The fake model reports 10 input and 5 output tokens a call, and no call may fail or repeat.
    await expect(purposes.getByRole("row", { name: "Test connection 1 0 10 5" })).toBeVisible();
    await expect(purposes.getByRole("row", { name: "Classify 4 0 40 20" })).toBeVisible();
    await expect(purposes.getByRole("row", { name: "Extract and rate 4 0 40 20" })).toBeVisible();
    await expect(page.getByRole("region", { name: "By model" })).toContainText("fake-model");
  });
});

// The M3 demo: a high-Severity Item sends a Telegram alert. Telegram is the fake-telegram container
// (compose.smoke.yaml), and mail goes to the worker's log, because the install has no mail server. The
// fake model rates an Item whose title says "outage" Severity 5. Backfill Items never fire Actions, so
// the feed's alerting entries appear after the Backfill, and the test asks for each poll with Check now rather
// than wait out the Source's schedule. The model is the one the M2 test added, so it runs after that test, and
// before the rate limit test below, which uses up the sign-in bucket.
test("a high-Severity Item sends a Telegram alert and a mail, and quiet hours hold the next one", async ({ page }) => {
  // Three polls, each waiting for the worker's tick, and the Feed's refresh after two of them.
  test.setTimeout(480_000);
  const chat = "Ops chat";
  const inbox = "Alert inbox";
  const address = "alerts@example.com";
  const backfilled = "Acme status page moves to a new address";
  const alerted = "Acme database outage in eu-west";
  const held = "Acme API outage in us-east";
  const feed = "alerts.xml";
  const log = itemLog(page);
  const actions = page.getByRole("region", { name: "Actions", exact: true });
  const botSent = async (text: string) => (await botMessages()).filter((sent) => sent.includes(text));
  const mailed = async (text: string) => (await workerMailsTo(address)).filter((mail) => mail.includes(text));

  /** Opens the Item from the Feed at its link's address, because a click while the rows settle does nothing. */
  const openItem = async (title: string) => {
    const link = page.getByRole("link", { name: title });
    await expect(link).toHaveAttribute("href", /^\/items\//, untilPolled);
    await page.goto(new URL((await link.getAttribute("href")) ?? "", page.url()).href);
  };

  /** Reloads the Item until its Actions say `text`, because the page doesn't follow its Deliveries. */
  const untilActionsSay = (text: string) =>
    expect(async () => {
      await page.reload();
      await expect(actions).toContainText(text, { timeout: 1_000 });
    }).toPass(untilPolled);

  await test.step("add a Telegram Destination, and the bot links the chat that sends it /start", async () => {
    await signInAgain(page);
    await addDestination(page, "Telegram chat", "Add Telegram chat", chat);
    const command = page.getByLabel(/send this there:$/);
    await expect(command).toHaveValue(/^\/start@watchdog_smoke_bot \S+$/);
    await sendToBot({ id: -1001, type: "group", title: "Smoke ops" }, await command.inputValue());
    await expect.poll(() => botSent(`Linked to ${chat} in Watchdog`)).toHaveLength(1);
    await page.getByRole("link", { name: "Reload this page" }).click();
    await expect(page.getByRole("status").filter({ hasText: `${chat} is linked.` })).toBeVisible();
  });

  await test.step("add an email Destination and confirm it through the mailed link", async () => {
    await addDestination(page, "Email address", "Add email address", inbox, { Address: address });
    await page.goto(await confirmationLink(address));
    await page.getByRole("button", { name: "Confirm this address" }).click();
    await expect(page.getByRole("heading", { name: "Address confirmed" })).toBeVisible();
  });

  await test.step("save an alert Action on Severity 4 or more to both", async () => {
    await page.goto(new URL("/rules", page.url()).href);
    await page.getByRole("link", { name: "New Action" }).click();
    await waitForEditor(page);
    await visibleField(page, "Name").fill("Outage alerts");
    await visibleField(page, "Field").selectOption("severity");
    await visibleField(page, "Value").fill("4");
    await page.getByRole("checkbox", { name: new RegExp(`^${chat}`) }).check();
    await page.getByRole("checkbox", { name: new RegExp(`^${inbox}`) }).check();
    await saveRule(page);
  });

  await test.step("add a Source, and its Backfill reaches the Feed", async () => {
    await page.goto(new URL("/sources", page.url()).href);
    await addRssSource(page, feed);
    await page.getByRole("link", { name: "Workspace" }).click();
    await expect(feedRow(page, backfilled), "the Backfill never reached the Feed").toContainText("Backfill", untilPolled);
  });

  await test.step("a Severity 5 Item sends one Telegram alert and one mail, and its Log says so", async () => {
    await publishEntry("first");
    await checkNow(page, feed);
    await page.getByRole("link", { name: "Workspace" }).click();
    await expect.poll(() => botSent(alerted), { ...untilPolled, message: "no Telegram alert arrived" }).toHaveLength(1);
    await expect.poll(() => mailed(alerted), { message: "no alert mail arrived" }).toHaveLength(1);
    await openItem(alerted);
    await untilActionsSay(`${chat} · Sent`);
    await expect(actions).toContainText(`${inbox} · Sent`);
    const link = page.url();
    expect((await botSent(alerted))[0]).toContain(link);
    expect((await mailed(alerted))[0]).toContain(link);
    await expect(log.filter({ hasText: "Action Outage alerts fired" })).toContainText("Severity is at least 4");
    await expect(log.filter({ hasText: `Sent to ${chat}` })).toHaveCount(1);
    await expect(log.filter({ hasText: `Sent to ${inbox}` })).toHaveCount(1);
  });

  await test.step("in quiet hours, the next Severity 5 Item is held", async () => {
    // The Workspace timezone is UTC until someone sets it.
    const clock = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString().slice(11, 16);
    await page.goto(new URL("/settings", page.url()).href);
    await page.getByLabel("Hold alerts during quiet hours").check();
    await visibleField(page, "From").fill(clock(-1));
    await visibleField(page, "Until").fill(clock(1));
    await page.getByRole("button", { name: "Save settings" }).click();
    const savedNotice = page.getByRole("status").filter({ hasText: "Settings saved." });
    await expect(savedNotice).toBeVisible();

    // The footer says the form holds edits, as Profile's does, and the saved notice steps aside.
    const unsaved = page.locator("form strong", { hasText: "Unsaved changes." });
    const quietHours = page.getByLabel("Hold alerts during quiet hours");
    await quietHours.uncheck();
    await expect(unsaved).toBeVisible();
    await expect(savedNotice).toBeHidden();
    await quietHours.check();
    await expect(unsaved).toHaveCount(0);
    await expect(savedNotice).toBeVisible();

    await publishEntry("second");
    await checkNow(page, feed);
    await page.getByRole("link", { name: "Workspace" }).click();
    await openItem(held);
    await untilActionsSay(`${chat} · Held until`);
    await expect(actions).toContainText(`${inbox} · Held until`);
    expect(await botSent(held)).toHaveLength(0);
    expect(await mailed(held)).toHaveLength(0);
    expect(await botSent(alerted), "the first Item's alert went more than once").toHaveLength(1);
    expect(await mailed(alerted), "the first Item's mail went more than once").toHaveLength(1);
  });
});

// The M4 demo: every Source type still in M4 delivers an Item, and a rendered page's Item holds the
// text only its script writes. GitHub answers from fake-github at its two fixed hosts and the websites
// from fixture-site (compose.smoke.yaml), so the run makes no request outside the Compose network. The
// inbox gets a POST to the URL its page shows, and the Telegram chat a message the test pushes through
// fake-telegram, after binding that chat with the link the Sources screen shows. MTProto has no fake
// server: packages/core/src/telegram/session.int.test.ts covers it, and this test doesn't claim it.
test("every Source type still in M4 delivers an Item", async ({ page }) => {
  // Two worker ticks for the websites, one for GitHub's Backfill, one for the Telegram message, and
  // the Feed's refresh after each.
  test.setTimeout(900_000);
  const release = "Acme app v2.4.0";
  const issue = "Export button loses the header row";
  const mention = "flipboard layout breaks on narrow screens";
  const status = "Acme platform status changed";
  const uptime = "Acme platform uptime changed";
  const changelog = "Acme platform changelog changed";
  const written = "Smoke inbox says hello";
  const posted = "Smoke group says the deploy is done";
  const chat = { id: -1002, type: "supergroup", title: "Smoke group" };
  const original = page.getByRole("region", { name: "Original text" });

  await test.step("sign in again", async () => {
    await signInAgain(page);
    await page.getByRole("link", { name: "Sources", exact: true }).click();
  });

  await test.step("add a GitHub Source of each kind", async () => {
    await addSource(page, "github-releases", [
      ["Repo", "acme/app"],
      ["Name (optional)", "Acme releases"],
    ]);
    await addSource(page, "github-issues", [
      ["Repo", "acme/app"],
      // The field is "GitHub token (optional)" only where the Workspace has a GitHub sign-in.
      ["#token", "smoke-token"],
      ["Name (optional)", "Acme issues"],
    ]);
    await addSource(page, "github-mentions", [
      ["Search for", "flipboard"],
      ["Only in (optional)", "acme/app"],
      // The field is "GitHub token (optional)" only where the Workspace has a GitHub sign-in.
      ["#token", "smoke-token"],
      ["Name (optional)", "flipboard mentions"],
    ]);
  });

  await test.step("add a website Source for each way of reading a page", async () => {
    await addSource(page, "website", [
      ["Page URL", fixturePage("status")],
      ["Name (optional)", "Platform status"],
    ]);
    await addSource(
      page,
      "website",
      [
        ["Page URL", fixturePage("uptime")],
        ["Name (optional)", "Platform uptime"],
      ],
      "obscura",
    );
    await addSource(
      page,
      "website",
      [
        ["Page URL", fixturePage("changelog")],
        ["Name (optional)", "Platform changelog"],
      ],
      "chromium",
    );
  });

  await test.step("add a webhook inbox, and post to the URL its page shows", async () => {
    await page.goto(new URL("/sources", page.url()).href);
    await expect(async () => {
      await page.locator("label:has(#type-webhook):visible").click({ timeout: 5_000 });
      await expect(page.locator("#type-webhook:checked")).toHaveCount(1, { timeout: 5_000 });
      const form = page.locator("form:has(#type-webhook:checked)").first();
      await form.locator("#mapTitle").fill("$.alert.title", { timeout: 5_000 });
      await form.getByLabel("Name (optional)", { exact: true }).fill("Smoke inbox", { timeout: 5_000 });
      // An inbox's add ends on the inbox's own page, because its URL is shown only once.
      await submitAdd(form);
      await expect(page.getByRole("heading", { name: "Smoke inbox", level: 1 })).toBeVisible({ timeout: 10_000 });
    }).toPass({ timeout: 90_000 });

    // The URL is shown on the page's first render only. A page that was rendered twice has used that
    // up, and the way to a second copy is to replace the token, as a person would.
    const inbox = page.getByRole("textbox", { name: "The inbox URL" });
    await expect(async () => {
      if ((await inbox.count()) === 0) {
        await page.getByText("Replace the token", { exact: true }).click({ timeout: 2_000 });
        await page.getByRole("button", { name: /^Replace it/ }).click({ timeout: 2_000 });
      }
      await expect(inbox).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });
    const answer = await page.request.post(await inbox.inputValue(), { data: { alert: { title: written } } });
    expect(answer.status(), "the inbox didn't capture the request").toBe(202);
  });

  await test.step("each website's first poll keeps the page as its Baseline", async () => {
    for (const name of ["Platform status", "Platform uptime", "Platform changelog"]) await waitForFirstPoll(page, name);
  });

  await test.step("a request flips the fixture site, and each website's next poll finds a change", async () => {
    await flipFixtureSite();
    for (const name of ["Platform status", "Platform uptime", "Platform changelog"]) await checkSourceNow(page, name);
  });

  await test.step("the link the Sources screen shows binds the group, and a message there becomes an Item", async () => {
    await addSource(page, "telegram", [["Name (optional)", "Smoke chat"]]);
    const command = page.locator("#telegram-command");
    await expect(command).toHaveValue(/^\/start@watchdog_smoke_bot \S+$/);
    await sendToBot(chat, await command.inputValue());
    await expect
      .poll(
        async () => (await botMessages()).filter((text) => text.includes("Watching this chat for Smoke chat in Watchdog")),
        untilPolled,
      )
      .toHaveLength(1);
    await sendToBot(chat, posted);
    await page.goto(new URL("/sources", page.url()).href);
    await expect(sourceRow(page, "Smoke chat"), "the bot never bound the chat").toContainText(chat.title, untilPolled);
  });

  await test.step("every Source's Item is in the Feed", async () => {
    await page.getByRole("link", { name: "Workspace" }).click();
    // Releases, issues and mentions read the Backfill's window; a website has none, and an inbox and a
    // chat are pushed to.
    for (const title of [release, issue, mention]) {
      await expect(feedRow(page, title), `"${title}" never reached the Feed`).toContainText("Backfill", untilPolled);
    }
    for (const title of [status, uptime, changelog, written, posted]) {
      await expect(feedRow(page, title), `"${title}" never reached the Feed`).toBeVisible(untilPolled);
    }
  });

  await test.step("a rendered page's Item holds the line only its script writes, and a static one doesn't", async () => {
    for (const title of [uptime, changelog]) {
      await openFeedItem(page, title);
      await expect(original, `${title} was read without running the page's script`).toContainText(
        "Rendered text: Partial outage in eu-west",
      );
      await page.getByRole("link", { name: "Feed", exact: true }).click();
    }
    await openFeedItem(page, status);
    await expect(original).toContainText("+ Partial outage in eu-west");
    await expect(original, "a Static read ran the page's script").not.toContainText("Rendered text:");
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
