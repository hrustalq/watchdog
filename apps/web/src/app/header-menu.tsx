"use client";

import type { ReactNode } from "react";

/**
 * The menu floats over the Feed, so keyboard users can leave it with Escape or by moving focus out.
 * A ref's cleanup also runs when Activity hides the page, so a menu left open doesn't come back open
 * on return. This lives outside the component, because a new ref on each render would close the menu
 * on every Feed refresh.
 */
function closeWhenLeft(menu: HTMLDetailsElement) {
  const listening = new AbortController();
  const { signal } = listening;
  document.addEventListener(
    "focusin",
    ({ target }) => {
      if (target instanceof Node && !menu.contains(target)) menu.open = false;
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    ({ key }) => {
      if (key !== "Escape" || !menu.open) return;
      menu.open = false;
      menu.querySelector("summary")?.focus();
    },
    { signal },
  );
  return () => {
    listening.abort();
    menu.open = false;
  };
}

/**
 * The header's controls where no row beside the Workspace name fits them. It opens without
 * JavaScript. The panel hangs from the header, because hung from the menu it would leave the screen
 * under large text, where nothing could scroll to it.
 *
 * While it's open the summary's ::before covers the page, so a tap anywhere closes it, with or without
 * JavaScript, and can't land on a Correction underneath, while a drag still scrolls. The summary skips
 * the button's press nudge, because a transform would shrink that cover to the summary mid-tap.
 */
export function HeaderMenu({ children }: { children: ReactNode }) {
  return (
    <details ref={closeWhenLeft} className="group">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg border border-transparent px-3 text-sm font-medium outline-hidden select-none group-open:before:fixed group-open:before:inset-0 group-open:before:z-10 group-open:before:cursor-default hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/60 group-open:bg-muted dark:hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        Menu
      </summary>
      <div className="absolute top-full right-4 z-10 mt-1 flex w-40 max-w-[calc(100vw-2rem)] flex-col rounded-lg border bg-popover p-1 shadow-md [&>a]:justify-start">
        {children}
      </div>
    </details>
  );
}
