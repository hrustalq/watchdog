import { dataBox, field, fieldError, label as labelClass } from "@/components/field-classes";
import { type ModelProblem, modelProblemMessage, providerTypes } from "@/lib/model";
import { SubmitButton } from "../sign-in/submit-button";
import { saveModelAction } from "./actions";

export interface ModelFormValues {
  providerType: string;
  baseUrl: string;
  modelName: string;
  structured: boolean;
  inputPrice: string;
  outputPrice: string;
}

/**
 * Sets the Workspace's model. The key field is never filled in: the page only knows whether a key
 * is set, and a blank field keeps it.
 */
export function ModelForm({
  values,
  hasKey,
  editing,
  problem,
  keyTyped,
}: {
  values: ModelFormValues;
  hasKey: boolean;
  /** Whether this changes a saved model rather than adding the first one. */
  editing: boolean;
  problem: ModelProblem | undefined;
  /** The last submit held a key, and it's gone: a refused form doesn't carry it back. */
  keyTyped: boolean;
}) {
  const invalid = (name: ModelProblem) => ({
    "aria-invalid": problem === name,
    "aria-describedby": `${name}-note`,
    // Focus lands on the field with the error, so the field and its message are read together.
    autoFocus: problem === name,
  });
  const note = (name: ModelProblem, hint?: React.ReactNode) =>
    problem === name ? (
      <p id={`${name}-note`} role="alert" className={fieldError}>
        {modelProblemMessage[name]}
      </p>
    ) : (
      <p id={`${name}-note`} className="text-xs text-muted-foreground">
        {hint}
      </p>
    );
  const examples = providerTypes.map(({ label, baseUrl }, index) => (
    <span key={label}>
      {index > 0 ? ", " : ""}
      {label}: <span className="font-mono break-all">{baseUrl}</span>
    </span>
  ));

  return (
    <form action={saveModelAction} className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label htmlFor="provider" className={labelClass}>
            Provider type
          </label>
          <select
            id="provider"
            name="providerType"
            defaultValue={values.providerType}
            {...invalid("provider")}
            className={`${field} bg-background`}
          >
            {providerTypes.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {note("provider", "OpenAI-compatible also covers OpenRouter, Groq, DeepSeek, Mistral, Ollama and LM Studio.")}
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="model-name" className={labelClass}>
            Model name
          </label>
          <input
            id="model-name"
            name="modelName"
            type="text"
            required
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            placeholder="gpt-5-mini"
            defaultValue={values.modelName}
            {...invalid("model-name")}
            className={`${field} ${dataBox}`}
          />
          {note("model-name", "As the provider spells it.")}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="base-url" className={labelClass}>
          Base URL
        </label>
        <input
          id="base-url"
          name="baseUrl"
          type="url"
          required
          autoComplete="off"
          spellCheck={false}
          placeholder="https://api.openai.com/v1"
          defaultValue={values.baseUrl}
          {...invalid("base-url")}
          className={`${field} ${dataBox}`}
        />
        {note("base-url", <>With its version path. {examples}.</>)}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="api-key" className={labelClass}>
          API key <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <input
          id="api-key"
          name="apiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={hasKey ? "Leave blank to keep the current key" : "None"}
          {...invalid("api-key")}
          className={`${field} ${dataBox}`}
        />
        {note(
          "api-key",
          <>
            {keyTyped ? <strong className="font-medium text-foreground">Enter the key again. </strong> : null}
            {hasKey
              ? "A new key replaces the current one. A key stays with its address: changing the provider type or the host needs the key again."
              : "Stored encrypted, and never shown again. Leave it blank for a local model that needs none."}
          </>,
        )}
      </div>

      <div className="flex items-start gap-2">
        <input
          id="structured"
          name="structured"
          type="checkbox"
          defaultChecked={values.structured}
          aria-describedby="structured-hint"
          className="mt-0.5 size-4 shrink-0 accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="structured" className={labelClass}>
            Supports structured output
          </label>
          <p id="structured-hint" className="text-xs text-muted-foreground">
            The host accepts a JSON Schema. Without this, Watchdog asks for plain JSON and checks what comes back.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <PriceField
          id="input-price"
          name="inputPrice"
          label="Input price"
          value={values.inputPrice}
          aria={invalid("input-price")}
          note={note("input-price", "Per million tokens, for the estimated cost on the Usage screen.")}
        />
        <PriceField
          id="output-price"
          name="outputPrice"
          label="Output price"
          value={values.outputPrice}
          aria={invalid("output-price")}
          note={note("output-price", "Per million tokens.")}
        />
      </div>

      {editing ? (
        <p className="text-sm text-muted-foreground">
          A new provider type, base URL or model name replaces this model. Usage history keeps the old one.
        </p>
      ) : null}
      <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start">
        Save model
      </SubmitButton>
    </form>
  );
}

function PriceField({
  id,
  name,
  label,
  value,
  aria,
  note,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  aria: { "aria-invalid": boolean; "aria-describedby": string; autoFocus: boolean };
  note: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={labelClass}>
        {label} <span className="font-normal text-muted-foreground">(optional)</span>
      </label>
      <input
        id={id}
        name={name}
        type="number"
        min="0"
        step="any"
        inputMode="decimal"
        defaultValue={value}
        {...aria}
        className={`${field} ${dataBox} tabular-nums`}
      />
      {note}
    </div>
  );
}
