"use client";

import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { cn } from "@/lib/utils";

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

export function WorkspaceMenu({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <details ref={closeWhenLeft} className="group relative h-full">
      <summary
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-16 w-full cursor-pointer list-none flex-col items-center justify-center gap-1 px-1 text-xs font-medium outline-hidden select-none group-open:before:fixed group-open:before:inset-0 group-open:before:z-10 group-open:before:cursor-default focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/60 [&::-webkit-details-marker]:hidden",
          active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        )}
      >
        <Menu aria-hidden="true" className="size-5" />
        More
      </summary>
      <div className="absolute right-0 bottom-full z-20 mb-2 flex w-48 max-w-[calc(100vw-2rem)] flex-col rounded-lg border bg-popover p-1 shadow-md">
        {children}
      </div>
    </details>
  );
}
