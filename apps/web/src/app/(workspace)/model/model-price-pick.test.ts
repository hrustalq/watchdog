import { describe, expect, it } from "vitest";
import { pickPrefill } from "./model-price-pick.ts";

const model = (inputPricePerMillion: number | null, outputPricePerMillion: number | null) => ({
  id: "gpt-5",
  inputPricePerMillion,
  outputPricePerMillion,
});

describe("the prices a pick fills in", () => {
  it("fills both fields from the provider's list when neither holds a number", () => {
    expect(pickPrefill(model(0.15, 0.6), { inputPrice: "", outputPrice: "" })).toEqual({
      inputPrice: "0.15",
      outputPrice: "0.6",
    });
  });

  it("never replaces a price that is already there", () => {
    expect(pickPrefill(model(0.15, 0.6), { inputPrice: "2", outputPrice: "" })).toBeUndefined();
    expect(pickPrefill(model(0.15, 0.6), { inputPrice: "", outputPrice: "4" })).toBeUndefined();
  });

  it("leaves a provider that publishes no prices to the user", () => {
    expect(pickPrefill(model(null, null), { inputPrice: "", outputPrice: "" })).toBeUndefined();
  });

  it("has nothing to fill from a name that isn't in the list", () => {
    expect(pickPrefill(undefined, { inputPrice: "", outputPrice: "" })).toBeUndefined();
  });
});
