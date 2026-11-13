import { describe, expect, it } from "vitest";
import { callFailureInLog } from "./call-failure.ts";

describe("callFailureInLog", () => {
  it("names an invalid answer in plain words, with none of the validator's output", () => {
    const words = callFailureInLog({
      ok: false,
      reason: "invalid_output",
      message: "✖ Invalid input: expected number, received string\n  → at severity",
    });

    expect(words).toBe("the model's answer didn't match the shape Watchdog asked for");
    expect(words).not.toMatch(/[✖→]/);
    expect(words).not.toContain("severity");
    expect(words).not.toContain("Invalid input");
  });

  it("keeps a provider's or a Workspace's own sentence, as a row must be able to store it", () => {
    expect(
      callFailureInLog({ ok: false, reason: "error", message: "The model provider answered 500: the host is down" }),
    ).toBe("The model provider answered 500: the host is down");
    expect(callFailureInLog({ ok: false, reason: "unreadable_key", message: "Watchdog can't read the stored API key." })).toBe(
      "Watchdog can't read the stored API key.",
    );
    // A NUL and half a surrogate pair are what Postgres refuses, so they never reach the row.
    expect(callFailureInLog({ ok: false, reason: "error", message: "a\u0000b\uD800" })).toBe("ab\uFFFD");
  });
});
