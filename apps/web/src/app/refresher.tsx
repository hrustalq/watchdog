"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** How often a screen that is waiting on the pipeline asks the server for changes. */
const interval = 30_000;

/**
 * Whether a refresh would rewind something the user is in the middle of. A form that is saving says so
 * with `data-pending` (see `CorrectionStatus` and `RunStatus`), and the Correction forms' selects are
 * uncontrolled, so a re-render would drop a choice already made.
 */
function held() {
  return (
    document.querySelector("[data-pending]") !== null ||
    document.activeElement?.matches("input, textarea, select") === true
  );
}

/** What a screen passes to keep itself current. */
export interface Refreshing {
  paused?: boolean | undefined;
  watchFor?: number | undefined;
}

/**
 * Re-renders the screen from the server every 30 seconds while the tab is visible, and once when it
 * becomes visible again, so what the pipeline adds appears without a reload. A refresh keeps the
 * browser's scroll position and the client state of the components it doesn't replace, which is why it
 * can happen under the user's hands at all; `held` covers what it would still take away.
 *
 * `watchFor` bounds the waiting. A screen watching for something that may never come stops asking
 * after that long, and then only asks once each time the user comes back to the tab. Without it the
 * refreshing lasts as long as the screen does.
 */
export function useRefreshing({ paused = false, watchFor }: Refreshing = {}) {
  const router = useRouter();
  useEffect(() => {
    if (paused) return undefined;
    const refresh = () => {
      if (document.visibilityState === "visible" && !held()) router.refresh();
    };
    const timer = setInterval(refresh, interval);
    const stop =
      watchFor === undefined
        ? undefined
        : setTimeout(() => {
            clearInterval(timer);
          }, watchFor);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      if (stop !== undefined) clearTimeout(stop);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, paused, watchFor]);
}

/** A screen with nothing of its own to say while it waits: it only has to stay current. */
export function Refresher({ paused = false, watchFor }: Refreshing) {
  useRefreshing({ paused, watchFor });
  return null;
}
