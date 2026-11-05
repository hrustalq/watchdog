"use client";

import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";

/**
 * A menu floats over the Feed, so it closes on a tap outside it or on Escape. A ref's cleanup also
 * runs when Activity hides the page, so a menu left open doesn't come back open on return. This lives
 * outside the component, because a new ref on each render would close the menu on every Feed refresh.
 */
function closeWhenLeft(menu: HTMLDetailsElement) {
  const listening = new AbortController();
  const { signal } = listening;
  document.addEventListener(
    "pointerdown",
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

/** The header's links where no row beside the Workspace name fits them. It opens without JavaScript. */
export function HeaderMenu({ children }: { children: ReactNode }) {
  return (
    <details ref={closeWhenLeft} className="group relative shrink-0 md:hidden">
      <summary
        className={`${buttonVariants({ variant: "ghost" })} cursor-pointer list-none group-open:bg-muted dark:group-open:bg-muted/50 [&::-webkit-details-marker]:hidden`}
      >
        Menu
      </summary>
      <div className="absolute top-full right-0 z-10 mt-2 w-40 rounded-lg border bg-popover p-1 shadow-md">
        {children}
      </div>
    </details>
  );
}
