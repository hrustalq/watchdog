"use server";

import { linkCodeMinutes } from "@watchdog/core";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireWorkspace, server } from "@/lib/server";
import { replaceInboxToken } from "@/lib/inbox";
import { addFormSource, addValues, newSourceLink, removeSource, sourceLinkCookie, sourceLinkCookieValue } from "@/lib/sources";

// Both actions end in a redirect. Without JavaScript that's a 303 to a page the browser renders;
// an action that only returned would leave it a blank page. What the page then shows from the URL
// streams in, so it appears only with JavaScript, as on sign-in.

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Checks the feed, repo or search and saves it as a Source of the user's Workspace. A problem goes
 * back to the form as a code, with what was entered but the token, so the page can say what's wrong
 * and keep the values.
 */
export async function addSource(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const values = addValues((name) => text(formData, name));
  // Read apart from the values, which go into the URL: the token never leaves the server.
  const token = text(formData, "token");
  const { db, fetch, mode, encryptionKey, renderers, telegramAvailable } = server();
  // The form says Telegram isn't set up, and a post from before that isn't one to act on.
  if (values.type === "telegram" && !telegramAvailable) redirect("/sources");
  const result = await addFormSource(db, { fetch, mode, encryptionKey, renderers }, workspace.id, { ...values, token });
  // An inbox's page shows its URL, once. The id in the URL is all it carries.
  if ("source" in result && values.type === "webhook") redirect(`/sources/${result.source.id}/inbox`);
  if ("source" in result && result.code !== undefined) await showSourceLink(result.source.id, result.code);
  // The type stays chosen, so a second repo or feed can follow without choosing it again.
  if ("source" in result) redirect(`/sources?${new URLSearchParams({ added: "1", type: values.type })}`);
  const back = new URLSearchParams({ error: result.problem, ...values });
  if (result.status !== undefined) back.set("status", result.status);
  // Only that a token was pasted, so the form can ask for it again.
  if (token.trim() !== "") back.set("pasted", "1");
  redirect(`/sources?${back}`);
}

/** Keeps the code for the page to show, however often it's reloaded. See sourceLinkInCookie. */
async function showSourceLink(sourceId: string, code: string) {
  (await cookies()).set(sourceLinkCookie, sourceLinkCookieValue(sourceId, code), {
    httpOnly: true,
    sameSite: "lax",
    secure: server().baseURL.startsWith("https:"),
    path: "/sources",
    maxAge: linkCodeMinutes * 60,
  });
}

/** A new link for a Telegram bot Source that waits for the bot or lost access. It replaces the last one. */
export async function newSourceLinkAction(sourceId: unknown) {
  const { workspace } = await requireWorkspace();
  const id = typeof sourceId === "string" ? sourceId : "";
  const code = await newSourceLink(server().db, workspace.id, id);
  if (code !== undefined) await showSourceLink(id, code);
  redirect("/sources");
}

/** Removes a Source with its Items. An id outside the user's Workspace changes nothing. */
// Bound arguments come back from the client, so the id is checked against the Workspace.
export async function removeSourceAction(sourceId: unknown) {
  const { workspace } = await requireWorkspace();
  if (typeof sourceId === "string") await removeSource(server().db, workspace.id, sourceId);
  redirect("/sources");
}

/** Gives an inbox a new token, which its page then shows once. The old URL stops working at once. */
export async function replaceInboxTokenAction(sourceId: unknown) {
  const { workspace } = await requireWorkspace();
  const { db, encryptionKey } = server();
  const id = typeof sourceId === "string" ? sourceId : "";
  if (!(await replaceInboxToken(db, encryptionKey, workspace.id, id))) redirect("/sources");
  redirect(`/sources/${id}/inbox`);
}
