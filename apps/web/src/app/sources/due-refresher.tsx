"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

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
  useEffect(() => {
    if (!due && !wasDue.current) return undefined;
    wasDue.current = due;
    const timer = setInterval(() => {
      const typing = document.activeElement?.matches("input, textarea, select") === true;
      if (document.visibilityState === "visible" && !typing) router.refresh();
    }, interval);
    const stop = setTimeout(() => {
      clearInterval(timer);
    }, due ? whileDueFor : afterDueFor);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [due, router]);
  return null;
}
