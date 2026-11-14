"use client";

import { useSyncExternalStore } from "react";

// A screen keeps the text being written in `sessionStorage` while a save is unresolved, because a
// save can lose the page under it: a failure replaces it with the error page, and an expired session
// sends it to sign-in, which comes back without the text. The copy lives in one tab, so it goes when
// the tab does, and a Profile's words never reach the machine's disk the way `localStorage` would.

const root = "watchdog:draft:";

const keyOf = (page: string, field: string) => `${root}${page}:${field}`;

/** The page as the address bar has it: one screen, with the query that says which rule is being written. */
export function draftPage() {
  return window.location.pathname + window.location.search;
}

/** What this tab kept for `field` of `page`, or null when there's nothing to bring back. */
export function keptDraft(page: string, field: string): string | null {
  try {
    return sessionStorage.getItem(keyOf(page, field));
  } catch {
    // Storage is off, which costs the draft and nothing else.
    return null;
  }
}

export function keepDraft(page: string, field: string, text: string) {
  try {
    sessionStorage.setItem(keyOf(page, field), text);
  } catch {
    // Storage is off, or full: the form still holds the text it's editing.
  }
}

/**
 * Forgets every draft whose page starts with `wanted`, which is what a save that went through leaves
 * behind: nothing. It takes a page, or the prefix of the screens that write into it.
 */
export function forgetDraft(wanted: string) {
  const from = `${root}${wanted}`;
  try {
    // Downwards, so removing the entry under the cursor can't skip the one before it.
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index) ?? "";
      if (key.startsWith(from)) sessionStorage.removeItem(key);
    }
  } catch {
    // Nothing to forget when storage is off.
  }
}

// Storage never changes under a mounted screen, since only a save writes to it.
const neverChanges = () => () => {
  // Nothing to subscribe to: the draft is written by a save, which reloads the screen that made it.
};

/** Nothing was kept on the server, which is what makes the first render the page the server sent. */
const noneKept = () => null;

/**
 * What this tab kept for `field`, or null. The server can't read storage, so it renders the saved text
 * and the browser swaps in the draft as it hydrates, before the first paint.
 *
 * `page` names a screen whose address changes, as the Profile's does when a save adds `?saved=1`.
 * Without it, the draft belongs to the address bar, which also says which rule is being written.
 */
export function useKeptDraft(field: string, page?: string): string | null {
  return useSyncExternalStore(neverChanges, () => keptDraft(page ?? draftPage(), field), noneKept);
}
