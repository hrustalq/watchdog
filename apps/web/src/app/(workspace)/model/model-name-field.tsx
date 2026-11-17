"use client";

import { useEffect, useRef, useState } from "react";
import { dataBox, fieldError } from "@/components/field-classes";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import type { StoredKey } from "@/lib/model";
import { cn } from "@/lib/utils";
import { listModelsAction } from "./actions";
import { modelListFailureMessage } from "./model-list-words";

/** Where the picker's list stands. Idle keeps manual entry first, and nothing is asked for. */
export type ListedModels =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; models: string[] }
  | { kind: "failed"; reason: keyof typeof modelListFailureMessage };

const helpText = "text-xs text-muted-foreground wrap-anywhere text-pretty";

/** What the field says under itself about the list, announced when it changes. */
function listStatus(listed: ListedModels) {
  switch (listed.kind) {
    case "idle":
      return "Load the provider's models, or type the name yourself.";
    case "loading":
      return "Loading the provider's models…";
    case "ready":
      return listed.models.length === 0
        ? "The provider listed no models. Type the name instead."
        : `${String(listed.models.length)} models. Pick one, or type a name.`;
    case "failed":
      return modelListFailureMessage[listed.reason];
  }
}

/** The button says what it will do, so a retry after a failure isn't a mystery. */
function loadLabel(listed: ListedModels) {
  switch (listed.kind) {
    case "loading":
      return "Loading…";
    case "failed":
      return "Try again";
    case "idle":
    case "ready":
      return "Load models";
  }
}

interface ModelNameFieldViewProps {
  value: string;
  listed: ListedModels;
  /** A refusal from the server's save, which is about this field rather than the list. */
  error: string | undefined;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onLoad: () => void;
}

/**
 * The Model screen's name field: free text first, with the provider's own list behind the arrow. A
 * list is an offer, never a requirement, so the box stays typeable in every state and the form saves
 * a typed name whatever loading did. Its status line is the only thing that changes, and it is
 * announced, because a failure here is otherwise invisible until a save.
 */
export function ModelNameFieldView({ value, listed, error, inputRef, onChange, onOpenChange, onLoad }: ModelNameFieldViewProps) {
  const id = "model-name";
  const statusId = `${id}-status`;
  const errorId = `${id}-error`;
  const describedBy = error === undefined ? `${statusId} ${id}-help` : `${statusId} ${errorId} ${id}-help`;
  const models = listed.kind === "ready" ? listed.models : [];

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>Model name</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Combobox
          items={models}
          value={value}
          onValueChange={(next) => {
            if (typeof next === "string") onChange(next);
          }}
          inputValue={value}
          onInputValueChange={onChange}
          onOpenChange={onOpenChange}
        >
          <ComboboxInput
            ref={inputRef}
            id={id}
            name="modelName"
            required
            maxLength={200}
            autoComplete="off"
            placeholder="gpt-5-mini"
            className={cn("w-full", dataBox)}
            aria-invalid={error !== undefined}
            aria-describedby={describedBy}
            aria-busy={listed.kind === "loading"}
          />
          <ComboboxContent>
            <ComboboxList>
              {models.map((model) => (
                <ComboboxItem key={model} value={model} className="font-mono text-[0.8125rem]">
                  {model}
                </ComboboxItem>
              ))}
            </ComboboxList>
            <ComboboxEmpty>No match. The box keeps what you typed.</ComboboxEmpty>
          </ComboboxContent>
        </Combobox>
        <Button
          type="button"
          variant="outline"
          onClick={onLoad}
          disabled={listed.kind === "loading"}
          className="shrink-0 sm:w-auto"
        >
          {loadLabel(listed)}
        </Button>
      </div>
      <p id={statusId} aria-live="polite" className={helpText}>
        {listStatus(listed)}
      </p>
      {error === undefined ? null : (
        <p id={errorId} role="alert" className={fieldError}>
          {error}
        </p>
      )}
      <p id={`${id}-help`} className={helpText}>
        As the provider&apos;s docs spell it. The list is read with the key above.
      </p>
    </div>
  );
}

/**
 * The name field and its list. The key rule lives on the server, so this sends what the form holds
 * and shows what comes back. It reads the form only when the user asks, or opens the picker with a
 * key already there: a request while the key is still being typed would be answered with a refusal.
 */
export function ModelNameField({
  defaultValue,
  storedKey,
  error,
}: {
  defaultValue: string;
  storedKey: StoredKey;
  error: string | undefined;
}) {
  const [value, setValue] = useState(defaultValue);
  const [listed, setListed] = useState<ListedModels>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);

  // A refused save focuses its field, as the text fields do.
  useEffect(() => {
    if (error !== undefined) inputRef.current?.focus();
  }, [error]);

  // The ids belong to one address, so changing the provider or base URL drops them: otherwise the
  // last provider's models stay selectable for a model the save would then describe differently.
  useEffect(() => {
    const form = inputRef.current?.form;
    if (form === null || form === undefined) return;
    const reset = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.id === "provider" || target.id === "base-url")) {
        setListed({ kind: "idle" });
      }
    };
    form.addEventListener("change", reset);
    form.addEventListener("input", reset);
    return () => {
      form.removeEventListener("change", reset);
      form.removeEventListener("input", reset);
    };
  }, []);

  function posted(name: string) {
    const form = inputRef.current?.form;
    const data = form === null || form === undefined ? undefined : new FormData(form);
    const field = data?.get(name);
    return typeof field === "string" ? field : "";
  }

  async function load() {
    setListed({ kind: "loading" });
    try {
      const outcome = await listModelsAction({
        providerType: posted("providerType"),
        baseUrl: posted("baseUrl"),
        apiKey: posted("apiKey"),
      });
      setListed(
        outcome.ok
          ? { kind: "ready", models: outcome.models.map(({ id }) => id) }
          : { kind: "failed", reason: outcome.reason },
      );
    } catch {
      // A refused session or a failed read mustn't leave the field saying "Loading…" for good.
      setListed({ kind: "failed", reason: "request-failed" });
    }
  }

  function opened(open: boolean) {
    if (!open || listed.kind !== "idle") return;
    // The saved key counts even though this field is blank: a blank key field keeps it on save.
    if (posted("apiKey") === "" && storedKey !== "set") return;
    void load();
  }

  return (
    <ModelNameFieldView
      value={value}
      listed={listed}
      error={error}
      inputRef={inputRef}
      onChange={setValue}
      onOpenChange={opened}
      onLoad={() => void load()}
    />
  );
}
