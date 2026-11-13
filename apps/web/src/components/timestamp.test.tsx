import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timestamp } from "./timestamp.tsx";

const at = new Date("2026-11-08T13:30:45.000Z");

describe("Timestamp", () => {
  it("keeps the date and the time each unbroken, with a break allowed only between them", () => {
    expect(renderToStaticMarkup(<Timestamp at={at} />)).toBe(
      '<time dateTime="2026-11-08T13:30:45.000Z" class="font-mono text-[0.8125rem]">' +
        '<span class="whitespace-nowrap">2026-11-08</span> <span class="whitespace-nowrap">13:30 UTC</span>' +
        "</time>",
    );
  });

  it("keeps the same markup to the second for a Log", () => {
    expect(renderToStaticMarkup(<Timestamp at={at} seconds />)).toContain(
      '<span class="whitespace-nowrap">13:30:45 UTC</span>',
    );
  });

  it("still reads as one value to a screen reader and to a copy", () => {
    const text = renderToStaticMarkup(<Timestamp at={at} />).replace(/<[^>]*>/g, "");
    expect(text).toBe("2026-11-08 13:30 UTC");
  });
});
