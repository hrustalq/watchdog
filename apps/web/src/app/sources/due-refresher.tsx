"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useInterval, useTimeout } from "usehooks-ts";

/** How often the Sources screen looks again. */
const interval = 5_000;
/** A worker that is down never runs the poll, so the looking stops. */
const whileDueFor = 5 * 60_000;
/** A poll stops being due when the worker starts it, and can take half a minute more to end. */
const afterDueFor = 60_000;

/**
 * Re-renders the Sources screen from the server while a Source's poll is due and for a minute after, so
 * the row shows how the poll went without a reload. It waits while the tab is hidden, and while a form
 * field has focus, because a notice that arrives with a refresh takes the focus.
 */
export function DueRefresher({ due }: { due: boolean }) {
  const router = useRouter();
  const wasDue = useRef(false);
  // The window `due` opened: it starts on the render that changes the value, and ends when it runs out.
  const [watching, setWatching] = useState(due);
  useEffect(() => {
    if (!due && !wasDue.current) return;
    wasDue.current = due;
    setWatching(true);
  }, [due]);
  const openFor = due ? whileDueFor : afterDueFor;
  useInterval(
    () => {
      const typing = document.activeElement?.matches("input, textarea, select") === true;
      if (document.visibilityState === "visible" && !typing) router.refresh();
    },
    watching ? interval : null,
  );
  useTimeout(
    () => {
      setWatching(false);
    },
    watching ? openFor : null,
  );
  return null;
}
