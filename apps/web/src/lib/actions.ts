// What only a save can know about an Action (docs: Rule model, "Actions"): the mode, and which
// Destinations the Workspace has. The Rules screen calls this once it can save Actions.
import { type Action, type Config, scheduleError } from "@watchdog/core";
import type { destination } from "@watchdog/db";
import type { RuleProblem } from "./rule-draft.ts";

export type WorkspaceDestination = Pick<typeof destination.$inferSelect, "name" | "type">;

function destinationError(action: Action, name: string, destinations: readonly WorkspaceDestination[]) {
  const found = destinations.find((other) => other.name === name);
  if (found === undefined) return `This Workspace has no Destination named “${name}”.`;
  if (action.kind === "webhook") {
    return found.type === "webhook"
      ? undefined
      : `A webhook Action sends only to webhook Destinations, and “${name}” isn't one.`;
  }
  if (found.type !== "webhook") return undefined;
  const noun = action.kind === "alert" ? "An alert" : "A Digest";
  return `${noun} sends only to Telegram and email Destinations, and “${name}” is a webhook Destination.`;
}

/** Why this Action, by its Destinations' names, can't be saved in this Workspace and mode. */
export function actionProblems(
  action: Action,
  destinations: readonly WorkspaceDestination[],
  mode: Config["mode"],
): RuleProblem[] {
  const problems: RuleProblem[] = [];
  for (const [index, name] of action.destinations.entries()) {
    const message = destinationError(action, name, destinations);
    if (message !== undefined) problems.push({ path: `destinations.${String(index)}`, message });
  }
  if (action.kind === "digest") {
    const message = scheduleError(action.schedule, mode);
    if (message !== undefined) problems.push({ path: "schedule", message });
  }
  return problems;
}
