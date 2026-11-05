"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { correctCategories, correctRating } from "@/lib/corrections";
import { pathHeader, returnTo } from "@/lib/return-to";
import { requireWorkspace, server } from "@/lib/server";
import { isUuid } from "@/lib/uuid";

export async function signOut() {
  const requestHeaders = await headers();
  await server().auth.api.signOut({ headers: requestHeaders });
  redirect("/sign-in");
}

/**
 * Shows the result. With JavaScript the action's response carries the fresh page, so nothing moves but
 * what changed. A plain form post has no such header, so the browser goes back to the page it posted
 * from, at the Item's row when that's the Feed, and a reload doesn't post it again.
 */
async function showCorrection(itemId: string) {
  // The Feed and the Item both show it, and Back would otherwise reuse the page from before it.
  revalidatePath("/", "layout");
  const requestHeaders = await headers();
  if (!requestHeaders.has("next-action")) {
    redirect(`${returnTo(requestHeaders.get(pathHeader))}#item-${itemId}`);
  }
}

const levelIn = (formData: FormData, axis: "severity" | "importance") => {
  const value = formData.get(axis);
  return typeof value === "string" && /^[1-5]$/.test(value) ? Number(value) : undefined;
};

const itemIdIn = (formData: FormData) => {
  const itemId = formData.get("itemId");
  return typeof itemId === "string" && isUuid(itemId) ? itemId : redirect("/");
};

/** Sets the level on each axis the form names. An id outside the user's Workspace changes nothing. */
export async function correctRatingAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const itemId = itemIdIn(formData);
  await correctRating(server().db, workspace.id, itemId, {
    severity: levelIn(formData, "severity"),
    importance: levelIn(formData, "importance"),
  });
  await showCorrection(itemId);
}

/** Adds or removes the Category the form names. An id outside the user's Workspace changes nothing. */
export async function correctCategoriesAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const itemId = itemIdIn(formData);
  const add = formData.get("add");
  const remove = formData.get("remove");
  if (typeof add === "string") await correctCategories(server().db, workspace.id, itemId, { add });
  else if (typeof remove === "string") await correctCategories(server().db, workspace.id, itemId, { remove });
  await showCorrection(itemId);
}
