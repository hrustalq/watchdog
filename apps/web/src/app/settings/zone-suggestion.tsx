"use client";

import { useState, useSyncExternalStore } from "react";
import { textLink } from "@/components/field-classes";
import { cn } from "@/lib/utils";

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const unchanging = () => () => undefined;

/**
 * Offers the browser's own timezone for the field, when it isn't the saved one. Without JavaScript
 * there's nothing to offer, so the server renders nothing and the field works as it is.
 */
export function ZoneSuggestion({ inputId, saved }: { inputId: string; saved: string }) {
  const zone = useSyncExternalStore(unchanging, browserZone, () => undefined);
  const [used, setUsed] = useState(false);
  if (zone === undefined || zone === saved) return null;
  if (used) return <p className="text-xs text-muted-foreground">Save settings to keep it.</p>;
  return (
    <p className="text-xs text-muted-foreground">
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
        className={cn(textLink, "cursor-pointer font-medium text-foreground")}
      >
        Use {zone}
      </button>
    </p>
  );
}
