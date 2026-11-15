"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useInterval, useTimeout } from "usehooks-ts";

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
  // A change of pause or of the window resets the wait during render, as the old effect did when it
  // re-ran. The key says which wait the timeout belongs to, so a late one can't end a new wait.
  const waitingFor = `${String(paused)}:${String(watchFor)}`;
  const [waiting, setWaiting] = useState({ key: waitingFor, over: false });
  if (waiting.key !== waitingFor) setWaiting({ key: waitingFor, over: false });
  useInterval(
    () => {
      if (document.visibilityState === "visible" && !held()) router.refresh();
    },
    paused || waiting.over ? null : interval,
  );
  useTimeout(
    () => {
      setWaiting((current) => (current.key === waitingFor ? { key: waitingFor, over: true } : current));
    },
    paused || watchFor === undefined ? null : watchFor,
  );
  useEffect(() => {
    if (paused) return undefined;
    const refresh = () => {
      if (document.visibilityState === "visible" && !held()) router.refresh();
    };
    document.addEventListener("visibilitychange", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, paused]);
}

/** A screen with nothing of its own to say while it waits: it only has to stay current. */
export function Refresher({ paused = false, watchFor }: Refreshing) {
  useRefreshing({ paused, watchFor });
  return null;
}
