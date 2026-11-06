import { describe, expect, it } from "vitest";
import { groupedAlert, groupedAlertText } from "./group.ts";

const appUrl = "https://watchdog.test";
const rated = (id: string, title: string | null = `Item ${id}`) => ({ id, title, severity: 4, importance: 3 });

describe("groupedAlert", () => {
  it("holds a count and one line per Item, in the order given", () => {
    const group = groupedAlert([rated("a", "First"), { id: "b", title: null, severity: null, importance: null }], appUrl);

    expect(group).toEqual({
      count: 2,
      lines: [
        { title: "First", rating: "Severity 4, Importance 3", link: "https://watchdog.test/items/a" },
        { title: "Untitled Item", rating: "unrated", link: "https://watchdog.test/items/b" },
      ],
      feedLink: "https://watchdog.test/",
    });
  });

  it("lists at most 50 Items and still counts them all", () => {
    const group = groupedAlert(Array.from({ length: 53 }, (_, index) => rated(String(index))), appUrl);

    expect(group.count).toBe(53);
    expect(group.lines).toHaveLength(50);
    expect(group.lines[49]?.title).toBe("Item 49");
  });
});

describe("groupedAlertText", () => {
  it("says how many, then one line for each Item", () => {
    const text = groupedAlertText(groupedAlert([rated("a", "First"), rated("b", "Second")], appUrl));

    expect(text).toBe(
      [
        "2 alerts",
        "First · Severity 4, Importance 3 · https://watchdog.test/items/a",
        "Second · Severity 4, Importance 3 · https://watchdog.test/items/b",
      ].join("\n"),
    );
  });

  it("links to the Feed for the Items past 50", () => {
    const text = groupedAlertText(groupedAlert(Array.from({ length: 53 }, (_, index) => rated(String(index))), appUrl));

    const lines = text.split("\n");
    expect(lines).toHaveLength(52);
    expect(lines[0]).toBe("53 alerts");
    expect(lines.at(-1)).toBe("and 3 more: https://watchdog.test/");
  });

  it("keeps an Item to one line whatever its title holds", () => {
    const text = groupedAlertText(groupedAlert([rated("a", "Real\n\nFake · Severity 5"), rated("b")], appUrl));

    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("Real Fake · Severity 5 · Severity 4, Importance 3");
  });

  it("cuts whole lines to fit a limit, and counts what it cut into the link to the Feed", () => {
    const group = groupedAlert(Array.from({ length: 50 }, (_, index) => rated(String(index), "x".repeat(100))), appUrl);

    const text = groupedAlertText(group, 1000);

    expect(text.length).toBeLessThanOrEqual(1000);
    const lines = text.split("\n");
    const listed = lines.length - 2;
    expect(listed).toBeGreaterThan(0);
    expect(lines.at(-1)).toBe(`and ${String(50 - listed)} more: https://watchdog.test/`);
    expect(lines[0]).toBe("50 alerts");
  });
});
