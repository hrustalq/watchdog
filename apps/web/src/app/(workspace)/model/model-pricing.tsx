"use client";

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import { dataBox } from "@/components/field-classes";
import { TextField } from "@/components/form-field";
import { cn } from "@/lib/utils";

/** The two prices as the form holds them, and whether the provider's list put them there. */
export interface ModelPricingValues {
  inputPrice: string;
  outputPrice: string;
  fromProvider: boolean;
}

interface ModelPricing extends ModelPricingValues {
  /** The picker's prices, which a save records as the provider's own. */
  setDetected: (prices: { inputPrice: string; outputPrice: string; modelId: string }) => void;
  /** A typed price is the user's, so the row stops claiming the provider's list. */
  edit: (field: "inputPrice" | "outputPrice", value: string) => void;
  /** A name that no longer matches the model the prices came from drops them, not just their label. */
  rename: (modelId: string) => void;
  /** Another provider or base URL drops prices the old address's list filled, for the same reason. */
  leaveDestination: () => void;
}

const ModelPricingContext = createContext<ModelPricing | undefined>(undefined);

/**
 * The prices one Model form holds. The picker fills them from the provider's list, and the fields
 * below it edit them; a save then knows which of the two wrote the number (GitHub issue #489).
 */
export function ModelPricingProvider({ initial, children }: { initial: ModelPricingValues; children: ReactNode }) {
  const [values, setValues] = useState(initial);
  // The listed id whose prices these are. A name or address that moves away from it drops them:
  // another model's numbers must never be saved as this one's, and certainly not as the provider's.
  const [detectedFor, setDetectedFor] = useState<string | undefined>(undefined);
  const pricing = useMemo<ModelPricing>(
    () => ({
      ...values,
      setDetected: ({ inputPrice, outputPrice, modelId }) => {
        setDetectedFor(modelId);
        setValues({ inputPrice, outputPrice, fromProvider: true });
      },
      edit: (field, value) => {
        setDetectedFor(undefined);
        setValues((held) => ({ ...held, [field]: value, fromProvider: false }));
      },
      rename: (modelId) => {
        if (detectedFor === undefined || detectedFor === modelId) return;
        setDetectedFor(undefined);
        setValues({ inputPrice: "", outputPrice: "", fromProvider: false });
      },
      leaveDestination: () => {
        if (detectedFor === undefined) return;
        setDetectedFor(undefined);
        setValues({ inputPrice: "", outputPrice: "", fromProvider: false });
      },
    }),
    [values, detectedFor],
  );
  return <ModelPricingContext value={pricing}>{children}</ModelPricingContext>;
}

export function useModelPricing() {
  const pricing = useContext(ModelPricingContext);
  if (pricing === undefined) throw new Error("A model price used outside the Model form's pricing provider");
  return pricing;
}

/**
 * The two price fields, which post themselves and say when a picker filled them. A hidden flag rides
 * with them so the save records the provider as the source without having to compare against the row.
 */
export function ModelPriceFields({
  inputError,
  outputError,
  focusOnError,
}: {
  inputError: string | undefined;
  outputError: string | undefined;
  /** The field the form's first problem is, so a refusal focuses it. */
  focusOnError: "input-price" | "output-price" | undefined;
}) {
  const { inputPrice, outputPrice, fromProvider, edit } = useModelPricing();
  const help = "Per million tokens, to estimate this model's cost.";

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        id="input-price"
        name="inputPrice"
        label="Input price"
        optional
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        value={inputPrice}
        onChange={(event) => {
          edit("inputPrice", event.target.value);
        }}
        error={inputError}
        focusOnError={focusOnError === "input-price"}
        showHelpWithError
        controlClassName={cn(dataBox, "tabular-nums")}
        help={help}
      />
      <TextField
        id="output-price"
        name="outputPrice"
        label="Output price"
        optional
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        value={outputPrice}
        onChange={(event) => {
          edit("outputPrice", event.target.value);
        }}
        error={outputError}
        focusOnError={focusOnError === "output-price"}
        showHelpWithError
        controlClassName={cn(dataBox, "tabular-nums")}
        help={help}
      />
      {fromProvider ? <input type="hidden" name="pricesFromProvider" value="1" /> : null}
    </div>
  );
}
