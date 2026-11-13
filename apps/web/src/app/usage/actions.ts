"use server";

import { redirect } from "next/navigation";
import { setArchivedPrices } from "@/lib/model";
import { requireWorkspace, server } from "@/lib/server";
import { parseMonth } from "@/lib/usage";

const text = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

/**
 * Sets the prices of an archived model from the Usage screen, then shows the month the form was on.
 * A refusal goes back to that month with what was typed, so the form reopens on the wrong field.
 */
export async function setPricesAction(formData: FormData) {
  const { workspace } = await requireWorkspace();
  const month = parseMonth(text(formData, "month"), new Date());
  const modelId = text(formData, "modelId");
  const inputPrice = text(formData, "inputPrice");
  const outputPrice = text(formData, "outputPrice");
  const result = await setArchivedPrices(server().db, workspace.id, modelId, { inputPrice, outputPrice });
  if ("problem" in result) {
    const query = new URLSearchParams({ month, error: result.problem, modelId, inputPrice, outputPrice });
    redirect(`/usage?${query.toString()}`);
  }
  redirect(`/usage?${new URLSearchParams({ month, saved: "prices" }).toString()}`);
}
