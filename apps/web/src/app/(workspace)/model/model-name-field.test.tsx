import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModelNameFieldView, type ListedModels } from "./model-name-field.tsx";
import { modelListFailureMessage } from "./model-list-words.ts";

/**
 * The field as the screen shows it. The picker's popup is portalled and only open on interaction, so
 * these assertions are about the parts a person always sees: the box, its button, its status line and
 * a refusal. The loaded ids themselves are covered by the core's list tests and the browser check.
 */
function field(listed: ListedModels, error?: string) {
  return renderToStaticMarkup(
    <ModelNameFieldView
      value=""
      listed={listed}
      error={error}
      inputRef={createRef<HTMLInputElement>()}
      onChange={() => undefined}
      onOpenChange={() => undefined}
      onLoad={() => undefined}
    />,
  );
}

describe("the Model screen's name field", () => {
  it("is a required, typeable box that posts the name, before any list is asked for", () => {
    const html = field({ kind: "idle" });

    expect(html).toContain('name="modelName"');
    expect(html).toContain("required");
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('placeholder="gpt-5-mini"');
    expect(html).toContain("Load models");
    expect(html).toContain("or type the name yourself");
  });

  it("announces that the list is loading, and keeps the box typeable meanwhile", () => {
    const html = field({ kind: "loading" });

    expect(html).toContain("Loading the provider&#x27;s models…");
    expect(html).toContain("Loading…");
    // Busy, not disabled: a disabled box wouldn't post the name it holds.
    const box = /<input id="model-name"[^>]*>/.exec(html)?.[0] ?? "";
    expect(box).toContain('aria-busy="true"');
    expect(box).not.toContain('disabled=""');
    expect(html).toContain('aria-live="polite"');
  });

  it("shows why a list failed, with a way to try again, and still saves a typed name", () => {
    const html = field({ kind: "failed", reason: "unauthorized" });

    expect(html).toContain(modelListFailureMessage.unauthorized);
    expect(html).toContain("Try again");
    expect(html).toContain('name="modelName"');
  });

  it("offers manual entry when the provider publishes no list", () => {
    const html = field({ kind: "failed", reason: "no-endpoint" });

    expect(html).toContain("Type the model&#x27;s name instead");
    expect(html).toContain('name="modelName"');
  });

  it("says how many models the provider listed", () => {
    const html = field({ kind: "ready", models: ["gpt-5", "gpt-5-mini"] });

    expect(html).toContain("2 models. Pick one, or type a name.");
  });

  it("doesn't pretend an empty list is a failure", () => {
    const html = field({ kind: "ready", models: [] });

    expect(html).toContain("The provider listed no models. Type the name instead.");
  });

  it("marks a refused name and points at the reason", () => {
    const html = field({ kind: "idle" }, "Enter the model's name as the provider spells it");

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("model-name-error");
  });
});
