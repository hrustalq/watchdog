import { describe, expect, it } from "vitest";
import { type FormOpenState, formOpens } from "./form-open.ts";

/** A saved model that works: the form has nothing to say, so it stays out of the way. */
const working: FormOpenState = {
  hasModel: true,
  unreadableKey: false,
  refused: false,
  keyLeftBehind: false,
  unreadableKeyTest: false,
};

describe("formOpens", () => {
  it("collapses a saved model with nothing to fix", () => {
    expect(formOpens(working)).toBe(false);
  });

  it("opens when the Workspace has no model yet", () => {
    expect(formOpens({ ...working, hasModel: false })).toBe(true);
  });

  it("opens after a refused save", () => {
    expect(formOpens({ ...working, refused: true })).toBe(true);
  });

  it("opens while the saved key can't be read, so the key field is there for the link", () => {
    expect(formOpens({ ...working, unreadableKey: true })).toBe(true);
  });

  it("opens when the save left the old key behind", () => {
    expect(formOpens({ ...working, keyLeftBehind: true })).toBe(true);
  });

  it("opens when the test found the key unreadable", () => {
    expect(formOpens({ ...working, unreadableKeyTest: true })).toBe(true);
  });
});
