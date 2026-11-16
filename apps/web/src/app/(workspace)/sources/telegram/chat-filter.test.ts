import { describe, expect, it } from "vitest";
import { matchingChats } from "./chat-filter.ts";

const titles = (chats: readonly { title: string }[]) => chats.map(({ title }) => title);

const chats = [{ title: "Watchdog operators" }, { title: "Product news" }, { title: "Ops alerts" }];

describe("matchingChats", () => {
  it("keeps only the chat whose title contains the filter, whatever its case", () => {
    expect(titles(matchingChats(chats, "WATCHDOG"))).toEqual(["Watchdog operators"]);
  });

  it("matches part of a title, not only its start", () => {
    expect(titles(matchingChats(chats, "new"))).toEqual(["Product news"]);
  });

  it("keeps every chat for an empty filter, in the order Telegram listed them", () => {
    expect(titles(matchingChats(chats, ""))).toEqual(["Watchdog operators", "Product news", "Ops alerts"]);
  });

  it("keeps nothing when no title contains the filter", () => {
    expect(titles(matchingChats(chats, "zzz"))).toEqual([]);
  });
});
