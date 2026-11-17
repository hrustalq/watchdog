import { dataBox } from "@/components/field-classes";
import { CheckboxField, SelectField, TextField } from "@/components/form-field";
import { type ModelProblem, modelProblemMessage, providerTypes, type StoredKey } from "@/lib/model";
import { cn } from "@/lib/utils";
import { saveModelAction } from "./actions";
import { ModelFormActions } from "./form-actions";
import { ModelNameField } from "./model-name-field";

export interface ModelFormValues {
  providerType: string;
  baseUrl: string;
  modelName: string;
  /** Kept through a refusal, so the box the user ticked stays ticked. */
  clearKey: boolean;
  structured: boolean;
  inputPrice: string;
  outputPrice: string;
}

const keyHint: Record<StoredKey, string> = {
  none: "Most hosted providers need one. Leave it blank if this model doesn't.",
  set: "Changing the provider type or the host needs the key again, because Watchdog won't send a key to another address.",
  unreadable: "Left blank on the same provider and host, the unreadable key stays.",
};

/** What an empty field means, which the box changes. */
const keyPlaceholder = (storedKey: StoredKey, clearKey: boolean) => {
  if (storedKey !== "set") return undefined;
  return clearKey ? "Leave blank to remove the stored key" : "Leave blank to keep the current key";
};

/**
 * Sets the Workspace's model. The key field is never filled in: the page only knows whether a key
 * is set, and a blank field keeps it. That holds for a key that can't be read too, so there the
 * form asks for the key instead of offering to keep it. Every field keeps its hint beside a refusal,
 * because the examples are what a refused field needs most.
 */
export function ModelForm({
  values,
  storedKey,
  problem,
  keyTyped,
}: {
  values: ModelFormValues;
  storedKey: StoredKey;
  problem: ModelProblem | undefined;
  /** The last submit held a key, and it's gone: a refused form doesn't carry it back. */
  keyTyped: boolean;
}) {
  const errorFor = (name: ModelProblem) => (problem === name ? modelProblemMessage[name] : undefined);
  const examples = providerTypes.map(({ label, baseUrl }) => (
    <span key={label} className="block wrap-anywhere">
      {label}: <span className="font-mono">{baseUrl}</span>
    </span>
  ));

  return (
    <form action={saveModelAction} className="flex flex-col gap-4">
      <SelectField
        id="provider"
        name="providerType"
        label="Provider type"
        defaultValue={values.providerType}
        error={errorFor("provider")}
        focusOnError={problem === "provider"}
        showHelpWithError
        help="OpenAI-compatible also covers OpenRouter, Groq, DeepSeek, Mistral, Ollama and LM Studio."
      >
        {providerTypes.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </SelectField>

      <TextField
        id="base-url"
        name="baseUrl"
        label="Base URL"
        type="url"
        required
        autoComplete="off"
        placeholder="https://api.openai.com/v1"
        defaultValue={values.baseUrl}
        error={errorFor("base-url")}
        focusOnError={problem === "base-url"}
        showHelpWithError
        controlClassName={dataBox}
        help={<>Include the version in the path. For example:{examples}</>}
      />

      <div className="flex flex-col gap-3">
        <TextField
          id="api-key"
          name="apiKey"
          label="API key"
          optional={storedKey !== "unreadable"}
          type="password"
          autoComplete="off"
          placeholder={keyPlaceholder(storedKey, values.clearKey)}
          error={errorFor("api-key")}
          focusOnError={problem === "api-key"}
          showHelpWithError
          controlClassName={dataBox}
          help={
            <>
              {keyTyped ? (
                <strong className="font-medium text-foreground">
                  {problem === "api-key" && values.clearKey && storedKey === "set" ? (
                    <>
                      A new key and the box that removes the stored key can&apos;t both be saved. Leave the key field
                      blank to remove the stored key, or untick the box to save this one.{" "}
                    </>
                  ) : (
                    <>
                      The key you typed wasn&apos;t saved. Enter it again
                      {storedKey === "set" && !values.clearKey ? ", or leave this blank to keep the current one" : ""}.{" "}
                    </>
                  )}
                </strong>
              ) : null}
              {storedKey === "unreadable" && !keyTyped ? (
                <strong className="font-medium text-foreground">Enter this model&apos;s key and save. </strong>
              ) : null}
              Stored encrypted, and never shown again. {keyHint[storedKey]}
            </>
          }
        />
        {/* Only offered while a key is set: with none there's nothing to remove. */}
        {storedKey === "set" ? (
          <CheckboxField
            id="clear-key"
            name="clearKey"
            label="Remove the stored key"
            defaultChecked={values.clearKey}
            help="Deletes the saved key when you save, and keeps this model, its prices and its Usage history. Leave the key field above blank."
          />
        ) : null}
      </div>

      <ModelNameField
        defaultValue={values.modelName}
        storedKey={storedKey}
        error={errorFor("model-name")}
      />

      <CheckboxField
        id="structured"
        name="structured"
        label="Supports structured output"
        defaultChecked={values.structured}
        help="The host accepts a JSON Schema. Without this, Watchdog asks for plain JSON and checks what comes back. Leave it off if you're not sure."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            { id: "input-price", name: "inputPrice", label: "Input price", value: values.inputPrice },
            { id: "output-price", name: "outputPrice", label: "Output price", value: values.outputPrice },
          ] as const
        ).map(({ id, name, label, value }) => (
          <TextField
            key={id}
            id={id}
            name={name}
            label={label}
            optional
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            defaultValue={value}
            error={errorFor(id)}
            focusOnError={problem === id}
            showHelpWithError
            controlClassName={cn(dataBox, "tabular-nums")}
            help="Per million tokens, to estimate this model's cost."
          />
        ))}
      </div>

      <ModelFormActions />
    </form>
  );
}
