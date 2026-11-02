import { describe, expect, it } from "vitest";
import { packageName } from "./index.ts";

describe("@watchdog/core", () => {
  it("exports its package name", () => {
    expect(packageName).toBe("@watchdog/core");
  });
});
