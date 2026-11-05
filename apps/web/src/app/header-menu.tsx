"use client";

import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";

/**
 * The menu floats over the Feed, so it closes on a press or focus outside it, and on Escape. A ref's
 * cleanup also runs when Activity hides the page, so a menu left open doesn't come back open on
 * return. This lives outside the component, because a new ref on each render would close the menu on
 * every Feed refresh.
 */
function closeWhenLeft(menu: HTMLDetailsElement) {
  const listening = new AbortController();
  const { signal } = listening;
  const closeIfOutside = ({ target }: Event) => {
    if (target instanceof Node && !menu.contains(target)) menu.open = false;
  };
  document.addEventListener("pointerdown", closeIfOutside, { signal });
  document.addEventListener("focusin", closeIfOutside, { signal });
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
 */
export function HeaderMenu({ children }: { children: ReactNode }) {
  return (
    <details ref={closeWhenLeft} className="group">
      <summary
        className={`${buttonVariants({ variant: "ghost" })} cursor-pointer list-none group-open:bg-muted [&::-webkit-details-marker]:hidden`}
      >
        Menu
      </summary>
      <div className="absolute top-full right-4 z-10 mt-1 flex w-40 max-w-[calc(100vw-2rem)] flex-col rounded-lg border bg-popover p-1 shadow-md [&>a]:justify-start">
        {children}
      </div>
    </details>
  );
}
