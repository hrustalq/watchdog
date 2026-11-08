"use client";

import { useState, useSyncExternalStore } from "react";
import { textLink } from "@/components/field-classes";
import { cn } from "@/lib/utils";

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const unchanging = () => () => undefined;

/**
 * Offers the browser's own timezone for the field, when it isn't the saved one. Without JavaScript
 * there's nothing to offer, so the server renders an empty region and the field works as it is. The
 * region is there from the first render, so what it says after a click is announced.
 */
export function ZoneSuggestion({ inputId, saved }: { inputId: string; saved: string }) {
  const zone = useSyncExternalStore(unchanging, browserZone, () => undefined);
  const [used, setUsed] = useState(false);
  const offered = zone !== undefined && zone !== saved;
  return (
    <div role="status" className="text-xs text-muted-foreground empty:hidden">
      {offered && used ? <p className="font-medium text-foreground">Save settings to keep it.</p> : null}
      {offered && !used ? (
        <p>
          This browser is set to <span className="font-mono">{zone}</span>.{" "}
          <button
            type="button"
            onClick={() => {
              const input = document.getElementById(inputId);
              if (!(input instanceof HTMLInputElement)) return;
              input.value = zone;
              input.focus();
              setUsed(true);
            }}
            className={cn(textLink, "inline-flex min-h-6 cursor-pointer items-center font-medium text-foreground")}
          >
            Use {zone}
          </button>
        </p>
      ) : null}
    </div>
  );
}
