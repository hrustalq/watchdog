"use server";

import { redirect } from "next/navigation";
import { requireWorkspace, server } from "@/lib/server";
import { addRssSource, removeSource } from "@/lib/sources";

// Both actions end in a redirect. Without JavaScript that's a 303 to a page the browser renders;
// an action that only returned would leave it a blank page. What the page then shows from the URL
// streams in, so it appears only with JavaScript, as on sign-in.

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Checks the feed and saves it as a Source of the user's Workspace. A problem goes back to the
 * form as a code, with what was entered, so the page can say what's wrong and keep the values.
 */
export async function addSource(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const values = { url: text(formData, "url"), name: text(formData, "name"), schedule: text(formData, "schedule") };
  const { db, fetch, mode } = server();
  const result = await addRssSource(db, { fetch, mode }, workspace.id, values);
  if ("source" in result) redirect("/sources?added=1");
  const back = new URLSearchParams({ error: result.problem, ...values });
  if (result.status !== undefined) back.set("status", result.status);
  redirect(`/sources?${back}`);
}

/** Removes a Source with its Items. An id outside the user's Workspace changes nothing. */
// Bound arguments come back from the client, so the id is checked against the Workspace.
export async function removeSourceAction(sourceId: unknown) {
  const { workspace } = await requireWorkspace();
  if (typeof sourceId === "string") await removeSource(server().db, workspace.id, sourceId);
  redirect("/sources");
}
