"use server";

import { refresh } from "next/cache";
import { requireWorkspace, server } from "@/lib/server";
import { addRssSource, removeSource } from "@/lib/sources";

export interface AddSourceState {
  /** Changes on every submit, so the form remounts with these values and focuses the error. */
  attempt: number;
  values: { url: string; name: string; schedule: string };
  error?: { field: "url" | "schedule"; message: string };
  added?: string;
}

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/** Checks the feed and saves it as a Source of the user's Workspace, or says why it can't. */
export async function addSource(previous: AddSourceState, formData: FormData): Promise<AddSourceState> {
  const { workspace } = await requireWorkspace();
  const values = { url: text(formData, "url"), name: text(formData, "name"), schedule: text(formData, "schedule") };
  const { db, fetch, mode } = server();
  const result = await addRssSource(db, { fetch, mode }, workspace.id, values);
  const attempt = previous.attempt + 1;
  if ("error" in result) {
    return { attempt, values, error: { field: result.field, message: result.error } };
  }
  refresh();
  return { attempt, values: { url: "", name: "", schedule: values.schedule }, added: result.source.name };
}

/** Removes a Source with its Items. An id outside the user's Workspace changes nothing. */
// Bound arguments come back from the client, so the id is checked against the Workspace.
export async function removeSourceAction(sourceId: unknown) {
  const { workspace } = await requireWorkspace();
  if (typeof sourceId === "string") await removeSource(server().db, workspace.id, sourceId);
  refresh();
}
