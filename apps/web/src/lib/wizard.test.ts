import { describe, expect, it } from "vitest";
import { doneIn, skippedIn, stepFrom, stepState, withSkipped, wizardHref } from "./wizard.ts";

describe("the guided setup's URL", () => {
  it("reads the four steps and the finish screen, and nothing else", () => {
    expect(["1", "2", "3", "4"].map((value) => stepFrom(value))).toEqual([1, 2, 3, 4]);
    for (const value of ["0", "5", "done", "01", 2, undefined, null]) expect(stepFrom(value)).toBeUndefined();
    expect(doneIn("done")).toBe(true);
    for (const value of ["finished", "5", undefined]) expect(doneIn(value)).toBe(false);
  });

  it("reads skipped steps in the list's order, without repeats or unknown ones", () => {
    expect(skippedIn("destination,rules,items")).toEqual(["items", "rules", "destination"]);
    expect(skippedIn("rules,rules,elsewhere")).toEqual(["rules"]);
    for (const value of ["", undefined, 3, ["items"]]) expect(skippedIn(value)).toEqual([]);
  });

  it("adds a skipped step once, keeping the list's order", () => {
    expect(withSkipped([], "items")).toEqual(["items"]);
    expect(withSkipped(["items"], "rules")).toEqual(["items", "rules"]);
    expect(withSkipped(["items", "destination"], "rules")).toEqual(["items", "rules", "destination"]);
    expect(withSkipped(["items"], "items")).toEqual(["items"]);
  });

  it("builds a URL that survives a reload and a Back", () => {
    expect(wizardHref(1)).toBe("/sources/new?step=1");
    expect(wizardHref(2, "a-source")).toBe("/sources/new?step=2&source=a-source");
    expect(wizardHref(3, "a-source", {}, ["items"])).toBe("/sources/new?step=3&source=a-source&skipped=items");
    expect(wizardHref("done", "a-source", { destination: "one" }, ["rules"])).toBe(
      "/sources/new?step=done&source=a-source&skipped=rules&destination=one",
    );
    // A name from the URL is escaped, not appended raw.
    expect(wizardHref(3, "a source")).toBe("/sources/new?step=3&source=a+source");
  });
});

describe("the step a URL can run", () => {
  const state = (raw: string, hasSource: boolean) => {
    const done = doneIn(raw);
    return stepState({ done, step: stepFrom(raw), hasSource, raw });
  };

  it("renders the first step and needs no address when no Source or step is named", () => {
    expect(state("", false)).toEqual({ finished: false, shown: 1, needsAddress: false });
  });

  it("starts at Items when the Source exists but the URL names no step", () => {
    expect(state("", true)).toEqual({ finished: false, shown: 2, needsAddress: false });
  });

  it("keeps an addressable step, including going back to add another Source", () => {
    expect(state("1", true)).toEqual({ finished: false, shown: 1, needsAddress: false });
    expect(state("3", true)).toEqual({ finished: false, shown: 3, needsAddress: false });
    expect(state("4", true)).toEqual({ finished: false, shown: 4, needsAddress: false });
  });

  it("falls back to the first step when a later step has no Source, and corrects the address", () => {
    expect(state("3", false)).toEqual({ finished: false, shown: 1, needsAddress: true });
    expect(state("done", false)).toEqual({ finished: false, shown: 1, needsAddress: true });
  });

  it("falls back to Items when the step is unknown but the Source exists", () => {
    expect(state("9", true)).toEqual({ finished: false, shown: 2, needsAddress: true });
  });

  it("shows the finish screen only when it has a Source", () => {
    expect(state("done", true)).toEqual({ finished: true, shown: 2, needsAddress: false });
  });
});
