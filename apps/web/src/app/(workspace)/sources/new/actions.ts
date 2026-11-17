"use server";

import { draftToYaml } from "@watchdog/core/rules/draft";
import { linkCodeMinutes, starterRulesFor } from "@watchdog/core";
import { action, and, destination, eq } from "@watchdog/db";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  addEmailDestination,
  addTelegramDestination,
  addWebhookDestination,
  telegramLinkCookie,
  telegramLinkCookieValue,
} from "@/lib/destinations";
import { declaredFields, importanceAlertExists, ruleNames, saveRule } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import { keepSentBack } from "@/lib/sent-back";
import { keepSourceLink } from "@/lib/source-link";
import { checkGapMinutes, checkSourceNow, guidedSource, newSourceLink } from "@/lib/sources";
import { skippedIn, wizardHref } from "@/lib/wizard";

// Every action ends in a redirect, as the other screens' do, because a form posted without
// JavaScript would otherwise render a blank page. Each step's form is its own transaction; a refused
// Destination can't undo a rule, and a refused rule can't undo the Source.

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

function back(url: string): never {
  revalidatePath("/sources/new");
  redirect(url);
}

/** Check now on the Items step: makes the Source due and comes back to the same step. */
export async function checkSourceInWizardAction(sourceId: unknown, formData: FormData) {
  const { workspace } = await requireWorkspace();
  const { db, mode, encryptionKey, authSecret } = server();
  const id = typeof sourceId === "string" ? sourceId : "";
  const skipped = skippedIn(formData.get("skipped"));
  if ((await guidedSource(db, workspace.id, id)) === undefined) back(wizardHref(1));
  const checked = await checkSourceNow(db, workspace.id, id, checkGapMinutes(mode), { encryptionKey, authSecret });
  back(wizardHref(2, id, checked ? { checked: "1" } : { "check-later": "1" }, skipped));
}

/** A new bot link for a Telegram Source that has no code this browser can show. */
export async function newSourceLinkInWizardAction(sourceId: unknown, formData: FormData) {
  const { workspace } = await requireWorkspace();
  const { db } = server();
  const id = typeof sourceId === "string" ? sourceId : "";
  const skipped = skippedIn(formData.get("skipped"));
  if ((await guidedSource(db, workspace.id, id)) === undefined) back(wizardHref(1));
  const code = await newSourceLink(db, workspace.id, id);
  if (code !== undefined) await keepSourceLink(id, code);
  back(wizardHref(2, id, {}, skipped));
}

/**
 * Saves one starter rule through the Rules editor's own path. The key comes from the browser, so it
 * only picks one of the starters the Workspace is actually offered; anything else changes nothing.
 * A refusal, such as a hosted rule limit, goes back as a message in the draft cookie, never the URL.
 */
export async function saveStarterRuleAction(sourceId: unknown, key: unknown, formData: FormData) {
  const { workspace } = await requireWorkspace();
  const { db, mode, ruleLimits } = server();
  const id = typeof sourceId === "string" ? sourceId : "";
  const skipped = skippedIn(formData.get("skipped"));
  const source = await guidedSource(db, workspace.id, id);
  if (source === undefined) back(wizardHref(1));

  const [declared, names] = await Promise.all([declaredFields(db, workspace.id), ruleNames(db, workspace.id)]);
  const starter = starterRulesFor(source, {
    declaredFields: declared.map(({ name }) => name),
    existingNames: names,
  }).find((rule) => rule.key === key);
  if (starter === undefined) back(wizardHref(3, id, {}, skipped));

  const result = await saveRule(db, workspace.id, null, draftToYaml(starter.draft), mode, ruleLimits);
  if ("saved" in result) back(wizardHref(3, id, { saved: starter.key }, skipped));

  await keepSentBack("/sources/new", { error: result.problems[0]?.message ?? "The rule couldn't be saved." });
  back(wizardHref(3, id, { refused: "1" }, skipped));
}

/** The one Action the guided setup creates: an alert when Importance is 4 or more. */
export async function saveWizardAlertAction(sourceId: unknown, destinationId: unknown, formData: FormData) {
  const { workspace } = await requireWorkspace();
  const { db, mode, ruleLimits } = server();
  const id = typeof sourceId === "string" ? sourceId : "";
  const targetId = typeof destinationId === "string" ? destinationId : "";
  const skipped = skippedIn(formData.get("skipped"));
  if ((await guidedSource(db, workspace.id, id)) === undefined) back(wizardHref(1));

  const [target] = await db
    .select({ name: destination.name, type: destination.type })
    .from(destination)
    .where(and(eq(destination.workspaceId, workspace.id), eq(destination.id, targetId)));
  // A webhook takes a webhook Action, and this is an alert: the step offers the alert for the other two.
  if (target === undefined || target.type === "webhook") back(wizardHref(4, id, {}, skipped));

  // Back and a double submit both return to the form that is already saved from. An identical alert
  // that is already enabled and pointed here is the one to land on, not a second one that doubles
  // every alert.
  if (await importanceAlertExists(db, workspace.id, targetId)) {
    back(wizardHref("done", id, { destination: targetId, alerted: "1" }, skipped));
  }

  const taken = new Set(
    (await db.select({ name: action.name }).from(action).where(eq(action.workspaceId, workspace.id))).map(
      ({ name }) => name,
    ),
  );
  let name = "Importance 4 alerts";
  for (let count = 2; taken.has(name); count += 1) name = `Importance 4 alerts ${String(count)}`;

  const draft = {
    action: name,
    when: { field: "importance", op: "gte", value: 4 },
    kind: "alert",
    destinations: [target.name],
  };
  const result = await saveRule(db, workspace.id, null, draftToYaml(draft), mode, ruleLimits);
  if ("saved" in result) {
    back(wizardHref("done", id, { destination: targetId, alerted: "1" }, skipped));
  }

  await keepSentBack("/sources/new", { error: result.problems[0]?.message ?? "The Action couldn't be saved." });
  back(wizardHref(4, id, { destination: targetId, refused: "1" }, skipped));
}

/** Keeps a Telegram Destination's link code for the wizard, on its own path. */
async function showTelegramLink(destinationId: string, code: string) {
  (await cookies()).set(telegramLinkCookie, telegramLinkCookieValue(destinationId, code), {
    httpOnly: true,
    sameSite: "lax",
    secure: server().baseURL.startsWith("https:"),
    path: "/sources/new",
    maxAge: linkCodeMinutes * 60,
  });
}

export async function addEmailInWizardAction(sourceId: unknown, formData: FormData) {
  const { user, workspace } = await requireWorkspace();
  const { db, destinationDeps } = server();
  const id = typeof sourceId === "string" ? sourceId : "";
  const skipped = skippedIn(formData.get("skipped"));
  if ((await guidedSource(db, workspace.id, id)) === undefined) back(wizardHref(1));

  const values = { name: text(formData, "name"), address: text(formData, "address") };
  const result = await addEmailDestination(db, destinationDeps, workspace.id, user, values);
  if ("problem" in result) {
    back(wizardHref(4, id, { form: "email", error: result.problem, ...values }, skipped));
  }
  back(wizardHref(4, id, { destination: result.destination.id, added: result.mail }, skipped));
}

export async function addWebhookInWizardAction(sourceId: unknown, formData: FormData) {
  const { workspace } = await requireWorkspace();
  const { db, destinationDeps } = server();
  const id = typeof sourceId === "string" ? sourceId : "";
  const skipped = skippedIn(formData.get("skipped"));
  if ((await guidedSource(db, workspace.id, id)) === undefined) back(wizardHref(1));

  const values = { name: text(formData, "name"), url: text(formData, "url") };
  const result = await addWebhookDestination(db, destinationDeps, workspace.id, values);
  // Not the URL, which can hold a secret and would stay in the history and any access log.
  if ("problem" in result) {
    back(wizardHref(4, id, { form: "webhook", error: result.problem, name: values.name }, skipped));
  }
  back(wizardHref(4, id, { destination: result.destination.id, secret: result.destination.id }, skipped));
}

export async function addTelegramInWizardAction(sourceId: unknown, formData: FormData) {
  const { workspace } = await requireWorkspace();
  const { db, telegramAvailable } = server();
  const id = typeof sourceId === "string" ? sourceId : "";
  const skipped = skippedIn(formData.get("skipped"));
  if ((await guidedSource(db, workspace.id, id)) === undefined) back(wizardHref(1));
  // The form says Telegram isn't set up, and a post from before that isn't one to act on.
  if (!telegramAvailable) back(wizardHref(4, id, { form: "telegram" }, skipped));

  const name = text(formData, "name");
  const result = await addTelegramDestination(db, workspace.id, { name });
  if ("problem" in result) {
    back(wizardHref(4, id, { form: "telegram", error: result.problem, name }, skipped));
  }
  await showTelegramLink(result.destination.id, result.code);
  back(wizardHref(4, id, { destination: result.destination.id }, skipped));
}
