// The guided setup's URL. Each step is addressable, so a refresh and the Back button keep both the
// step and the Source, and every link between steps is a plain URL that works without JavaScript.

export type WizardStep = 1 | 2 | 3 | 4;
export type WizardStage = WizardStep | "done";

/** A step the user left for now, which the finish screen reports. */
export const skippedSteps = ["items", "rules", "destination"] as const;
export type SkippedStep = (typeof skippedSteps)[number];

/** The step a URL names, or undefined for a value the wizard doesn't have. */
export function stepFrom(value: unknown): WizardStep | undefined {
  if (value === "1") return 1;
  if (value === "2") return 2;
  if (value === "3") return 3;
  if (value === "4") return 4;
  return undefined;
}

/** Whether a URL names the finish screen. */
export const doneIn = (value: unknown) => value === "done";

/** The skipped steps a URL names, in the order the wizard lists them. Unknown values are ignored. */
export function skippedIn(value: unknown): SkippedStep[] {
  if (typeof value !== "string") return [];
  const named = value.split(",");
  return skippedSteps.filter((step) => named.includes(step));
}

/** The skipped steps with one more, once, in the order the finish screen lists them. */
export function withSkipped(skipped: readonly SkippedStep[], add: SkippedStep): SkippedStep[] {
  return skippedSteps.filter((step) => step === add || skipped.includes(step));
}

/** What the page renders: the finish screen, the earliest runnable step, and whether to correct the URL. */
export function stepState({
  done,
  step,
  hasSource,
  raw,
}: {
  done: boolean;
  step: WizardStep | undefined;
  hasSource: boolean;
  raw: string;
}) {
  const finished = done && hasSource;
  // Without a Source only the first step can run. With one, a URL that names no step starts at Items,
  // because the Source already exists.
  const shown: WizardStep = hasSource ? (step ?? 2) : 1;
  const needsAddress =
    (done && !hasSource) || (!done && raw !== "" && step === undefined) || (!done && step !== undefined && step > 1 && !hasSource);
  return { finished, shown, needsAddress };
}

/**
 * A wizard URL. The step and the Source come first, then the steps skipped so far, then what the
 * step's own form reported. Only the Source's id and fixed codes travel, never a name or a form's
 * values, except a refused Destination's, which the Destinations screen puts in its URL too.
 */
export function wizardHref(
  step: WizardStage,
  sourceId?: string,
  extra: Record<string, string> = {},
  skipped: readonly SkippedStep[] = [],
) {
  const query = new URLSearchParams({ step: String(step) });
  if (sourceId !== undefined) query.set("source", sourceId);
  if (skipped.length > 0) query.set("skipped", skipped.join(","));
  for (const [key, value] of Object.entries(extra)) {
    if (value !== "") query.set(key, value);
  }
  return `/sources/new?${query.toString()}`;
}
