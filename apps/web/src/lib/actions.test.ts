import { type Action, actionSchema } from "@watchdog/core";
import { describe, expect, it } from "vitest";
import { actionProblems, type WorkspaceDestination } from "./actions.ts";

const when = { field: "severity", op: "gte", value: 4 };

const destinations: WorkspaceDestination[] = [
  { name: "ops-chat", type: "telegram" },
  { name: "me", type: "email" },
  { name: "crm-inbox", type: "webhook" },
];

const action = (kind: "alert" | "webhook", names: string[]): Action =>
  actionSchema.parse({ action: "a", when, kind, destinations: names });
const digest = (names: string[], schedule = "0 9 * * 1"): Action =>
  actionSchema.parse({ action: "a", when, kind: "digest", schedule, destinations: names });

describe("actionProblems", () => {
  it.each([
    ["an alert to Telegram and email", action("alert", ["ops-chat", "me"])],
    ["a webhook to a webhook", action("webhook", ["crm-inbox"])],
    ["a Digest to Telegram and email", digest(["ops-chat", "me"])],
  ])("has nothing to say about %s", (_, valid) => {
    expect(actionProblems(valid, destinations, "hosted")).toEqual([]);
  });

  it("refuses a name the Workspace has no Destination for, naming it", () => {
    expect(actionProblems(action("alert", ["me", "gone"]), destinations, "hosted")).toEqual([
      { path: "destinations.1", message: "This Workspace has no Destination named “gone”." },
    ]);
  });

  it.each([
    ["an alert", action("alert", ["crm-inbox"]), "An alert"],
    ["a Digest", digest(["crm-inbox"]), "A Digest"],
  ])("refuses a webhook Destination on %s, naming it", (_, wrong, noun) => {
    expect(actionProblems(wrong, destinations, "hosted")).toEqual([
      {
        path: "destinations.0",
        message: `${noun} sends only to Telegram and email Destinations, and “crm-inbox” is a webhook Destination.`,
      },
    ]);
  });

  it.each(["ops-chat", "me"])("refuses %s on a webhook Action, naming it", (name) => {
    expect(actionProblems(action("webhook", [name]), destinations, "hosted")).toEqual([
      {
        path: "destinations.0",
        message: `A webhook Action sends only to webhook Destinations, and “${name}” isn't one.`,
      },
    ]);
  });

  it("reports every Destination that is wrong, at its own place in the list", () => {
    const problems = actionProblems(action("alert", ["gone", "me", "crm-inbox"]), destinations, "hosted");
    expect(problems.map(({ path }) => path)).toEqual(["destinations.0", "destinations.2"]);
  });

  it("holds a Digest's schedule to the mode's minimum interval", () => {
    expect(actionProblems(digest(["me"], "* * * * *"), destinations, "self-hosted")).toEqual([
      {
        path: "schedule",
        message: "A schedule can't run more often than every 5 minutes on self-hosted.",
      },
    ]);
    const everyFive = digest(["me"], "*/5 * * * *");
    expect(actionProblems(everyFive, destinations, "self-hosted")).toEqual([]);
    expect(actionProblems(everyFive, destinations, "hosted")).toEqual([
      {
        path: "schedule",
        message: "A schedule can't run more often than every 15 minutes on hosted.",
      },
    ]);
  });
});
