"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addEmailDestination,
  addWebhookDestination,
  confirmDestination,
  removeDestination,
  replaceWebhookSecret,
  sendConfirmationAgain,
} from "@/lib/destinations";
import { requireWorkspace, server } from "@/lib/server";

// Every action ends in a redirect, as on Sources, because a form posted without JavaScript would
// otherwise render a blank page. The revalidate makes Back fetch the page again, so a secret it showed
// can't come back from the router's cache.

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

function back(query: Record<string, string>): never {
  revalidatePath("/destinations");
  redirect(`/destinations?${new URLSearchParams(query).toString()}`);
}

export async function addEmailAction(formData: FormData) {
  const { user, workspace } = await requireWorkspace();
  const values = { name: text(formData, "name"), address: text(formData, "address") };
  const { db, destinationDeps } = server();
  const result = await addEmailDestination(db, destinationDeps, workspace.id, user, values);
  if ("problem" in result) back({ form: "email", error: result.problem, ...values });
  back({ added: result.mail });
}

export async function addWebhookAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const values = { name: text(formData, "name"), url: text(formData, "url") };
  const { db, destinationDeps } = server();
  const result = await addWebhookDestination(db, destinationDeps, workspace.id, values);
  if ("problem" in result) back({ form: "webhook", error: result.problem, ...values });
  back({ secret: result.destination.id });
}

// Bound arguments come back from the client, so each id is checked against the Workspace.

export async function sendAgainAction(destinationId: unknown) {
  const { workspace } = await requireWorkspace();
  const { db, destinationDeps } = server();
  const id = typeof destinationId === "string" ? destinationId : "";
  back({ resent: await sendConfirmationAgain(db, destinationDeps, workspace.id, id) });
}

export async function replaceSecretAction(destinationId: unknown) {
  const { workspace } = await requireWorkspace();
  const { db, destinationDeps } = server();
  const id = typeof destinationId === "string" ? destinationId : "";
  const replaced = await replaceWebhookSecret(db, destinationDeps.encryptionKey, workspace.id, id);
  back(replaced ? { secret: id } : { missing: "1" });
}

export async function removeDestinationAction(destinationId: unknown) {
  const { workspace } = await requireWorkspace();
  const id = typeof destinationId === "string" ? destinationId : "";
  const result = await removeDestination(server().db, workspace.id, id);
  if (result === undefined) back({ missing: "1" });
  if ("refused" in result) back({ refused: id });
  // Ids, not names: the page looks them up, so a crafted link can't put words on it.
  back({ removed: "1", left: result.changed.join(",") });
}

/** The button on the emailed link's page. It needs no session, because the token is the proof. */
export async function confirmDestinationAction(formData: FormData) {
  const confirmed = await confirmDestination(server().db, text(formData, "token"));
  redirect(`/destinations/confirm?result=${confirmed ? "confirmed" : "invalid"}`);
}
