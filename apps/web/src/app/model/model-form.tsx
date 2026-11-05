import { dataBox, field, fieldError, label as labelClass } from "@/components/field-classes";
import { type ModelProblem, modelProblemMessage, providerTypes, type StoredKey } from "@/lib/model";
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

const keyHint: Record<StoredKey, string> = {
  none: "Most hosted providers need one. Leave it blank if this model doesn't.",
  set: "Changing the provider type or the host needs the key again, because Watchdog won't send a key to another address.",
  unreadable: "Left blank on the same provider and host, the unreadable key stays.",
};

/**
 * Sets the Workspace's model. The key field is never filled in: the page only knows whether a key
 * is set, and a blank field keeps it. That holds for a key that can't be read too, so there the
 * form asks for the key instead of offering to keep it.
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
  const invalid = (name: ModelProblem) => ({
    "aria-invalid": problem === name,
    "aria-describedby": `${name}-note`,
    // Focus lands on the field with the error, so the field and its message are read together.
    autoFocus: problem === name,
  });
  // The hint stays beside an error: a refused field is when its examples are needed most.
  const note = (name: ModelProblem, hint: React.ReactNode) => (
    <div id={`${name}-note`} className="flex flex-col gap-1">
      {problem === name ? (
        <p role="alert" className={fieldError}>
          {modelProblemMessage[name]}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
  const examples = providerTypes.map(({ label, baseUrl }) => (
    <span key={label} className="block wrap-anywhere">
      {label}: <span className="font-mono">{baseUrl}</span>
    </span>
  ));

  return (
    <form action={saveModelAction} className="flex flex-col gap-4">
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
        {note("base-url", <>Include the version in the path. For example:{examples}</>)}
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="api-key" className={labelClass}>
          API key {storedKey === "unreadable" ? null : <span className="font-normal text-muted-foreground">(optional)</span>}
        </label>
        <input
          id="api-key"
          name="apiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={storedKey === "set" ? "Leave blank to keep the current key" : undefined}
          {...invalid("api-key")}
          className={`${field} ${dataBox}`}
        />
        {note(
          "api-key",
          <>
            {keyTyped ? (
              <strong className="font-medium text-foreground">
                The key you typed wasn&apos;t saved. Enter it again
                {storedKey === "set" ? ", or leave this blank to keep the current one" : ""}.{" "}
              </strong>
            ) : null}
            {storedKey === "unreadable" && !keyTyped ? (
              <strong className="font-medium text-foreground">Enter this model&apos;s key and save. </strong>
            ) : null}
            Stored encrypted, and never shown again.{" "}
            {keyHint[storedKey]}
          </>,
        )}
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
        {note("model-name", "As the provider's docs spell it.")}
      </div>

      <div className="flex flex-col gap-1">
        {/* The label holds the box, so the whole row is the target. */}
        <label htmlFor="structured" className={`${labelClass} flex min-h-6 items-center gap-2`}>
          <input
            id="structured"
            name="structured"
            type="checkbox"
            defaultChecked={values.structured}
            aria-describedby="structured-hint"
            className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          Supports structured output
        </label>
        <p id="structured-hint" className="pl-6 text-xs text-muted-foreground">
          The host accepts a JSON Schema. Without this, Watchdog asks for plain JSON and checks what comes back. Leave it
          off if you&apos;re not sure.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            { id: "input-price", name: "inputPrice", label: "Input price", value: values.inputPrice },
            { id: "output-price", name: "outputPrice", label: "Output price", value: values.outputPrice },
          ] as const
        ).map(({ id, name, label, value }) => (
          <div key={id} className="flex flex-col gap-2">
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
              {...invalid(id)}
              className={`${field} ${dataBox} tabular-nums`}
            />
            {note(id, "Per million tokens, to estimate this model's cost.")}
          </div>
        ))}
      </div>

      <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start">
        Save model
      </SubmitButton>
    </form>
  );
}
