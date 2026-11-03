import { describe, expect, it } from "vitest";
import { detectLanguage } from "./language.ts";

describe("detectLanguage", () => {
  it("detects English", () => {
    expect(detectLanguage("Show HN: A tiny tool for watching feeds")).toBe("en");
  });

  it("detects Russian", () => {
    expect(detectLanguage("Вышел новый релиз PostgreSQL с улучшениями")).toBe("ru");
  });

  it("returns null for text too short to tell", () => {
    expect(detectLanguage("Hello")).toBeNull();
    expect(detectLanguage("v1.2.3 — 2026-11-03")).toBeNull();
    expect(detectLanguage("")).toBeNull();
  });
});
