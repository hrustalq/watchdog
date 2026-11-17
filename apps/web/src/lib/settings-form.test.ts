import { describe, expect, it } from "vitest";
import { formDiffers } from "./settings-form.ts";

/** A tab's form as it would post: the fields it holds, and the boxes that are ticked. */
const post = (values: Record<string, string>, ticked: readonly string[] = []) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(values)) data.append(name, value);
  for (const name of ticked) data.append(name, "on");
  return data;
};

/** The Delivery tab's fields as it starts from what's saved. */
const delivery = {
  timezone: "UTC",
  quietHours: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  severity5Bypasses: false,
  alertsPerHour: "20",
  burstWindowSeconds: "60",
};

/** What the Delivery form posts while it still holds what it started from. */
const asPosted = {
  timezone: "UTC",
  quietHoursStart: "22:00",
  quietHoursEnd: "07:00",
  alertsPerHour: "20",
  burstWindowSeconds: "60",
};

describe("formDiffers", () => {
  it("reads a form that still holds what it started from as unchanged", () => {
    expect(formDiffers(post(asPosted), delivery)).toBe(false);
  });

  it("reads a changed field, and a box that was ticked or unticked", () => {
    expect(formDiffers(post({ ...asPosted, alertsPerHour: "25" }), delivery)).toBe(true);
    expect(formDiffers(post(asPosted, ["quietHours"]), delivery)).toBe(true);
    expect(formDiffers(post(asPosted, ["severity5Bypasses"]), delivery)).toBe(true);
  });

  it("ignores a field the tab doesn't show, so the other tab's settings can't keep it looking changed", () => {
    expect(formDiffers(post({ ...asPosted, itemsRetentionDays: "90", logRetentionDays: "30" }), delivery)).toBe(false);
  });

  it("reads a saved field the form no longer holds as changed", () => {
    expect(formDiffers(post({}), delivery)).toBe(true);
  });
});
