import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelPriceFields, ModelPricingProvider } from "./model-pricing.tsx";

/** The two price boxes as the form renders them, with or without a pick behind them. */
function fields(fromProvider: boolean) {
  return renderToStaticMarkup(
    <ModelPricingProvider initial={{ inputPrice: "0.15", outputPrice: "0.6", fromProvider }}>
      <ModelPriceFields inputError={undefined} outputError={undefined} focusOnError={undefined} />
    </ModelPricingProvider>,
  );
}

describe("the Model form's price fields", () => {
  it("posts both prices under the names the save reads", () => {
    const html = fields(false);

    expect(html).toContain('name="inputPrice"');
    expect(html).toContain('name="outputPrice"');
    expect(html).toContain('value="0.15"');
    expect(html).toContain('value="0.6"');
  });

  it("carries the provider as the source only while a pick filled them", () => {
    expect(fields(true)).toContain('name="pricesFromProvider" value="1"');
    expect(fields(false)).not.toContain('name="pricesFromProvider"');
  });
});
