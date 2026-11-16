import { describe, expect, it } from "vitest";
import { isCurrentWorkspaceLink } from "./workspace-chrome";

describe("isCurrentWorkspaceLink", () => {
  it("marks Feed current on the Feed and Item screens", () => {
    expect(isCurrentWorkspaceLink("/", "/")).toBe(true);
    expect(isCurrentWorkspaceLink("/items/123", "/")).toBe(true);
    expect(isCurrentWorkspaceLink("/sources", "/")).toBe(false);
  });

  it("keeps a section current on its detail screens", () => {
    expect(isCurrentWorkspaceLink("/sources", "/sources")).toBe(true);
    expect(isCurrentWorkspaceLink("/sources/telegram", "/sources")).toBe(true);
    expect(isCurrentWorkspaceLink("/rules/classifier/123", "/rules")).toBe(true);
  });

  it("does not match a path that only shares a prefix", () => {
    expect(isCurrentWorkspaceLink("/sources-other", "/sources")).toBe(false);
    expect(isCurrentWorkspaceLink("/model-settings", "/model")).toBe(false);
  });
});
