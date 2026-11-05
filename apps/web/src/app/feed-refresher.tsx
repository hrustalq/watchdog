"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** How often an open Feed checks for changes. */
const interval = 30_000;

/** How long the list ignores clicks after its rows moved. */
const settleFor = 500;

/**
 * Re-renders the Feed from the server every 30 seconds while the tab is visible, and once when it
 * becomes visible again, so new Items and what the pipeline adds to them appear without a reload.
 * Screen readers hear how many Items arrived. When the rows move, `data-settling` lets the Feed ignore
 * clicks for a moment, so a second click at the same spot can't correct a different Item. Editing mode
 * pauses the refreshing, so only the user's own Corrections move rows under the pointer.
 */
export function FeedRefresher({ ids, paused }: { ids: string[]; paused: boolean }) {
  const router = useRouter();
  const [shown, setShown] = useState(ids);
  const [announcement, setAnnouncement] = useState("");
  // Counts the moves, so one during the wait starts it again.
  const [settling, setSettling] = useState(0);

  // Every refresh brings a new array, so this runs once per refresh, during render.
  if (ids !== shown) {
    setShown(ids);
    const arrived = ids.filter((id) => !shown.includes(id)).length;
    // Cleared when nothing arrived, so the same count next time is a change screen readers announce.
    setAnnouncement(arrived === 0 ? "" : `${String(arrived)} new ${arrived === 1 ? "Item" : "Items"} in the Feed`);
    if (ids.join() !== shown.join()) setSettling((moves) => moves + 1);
  }

  useEffect(() => {
    if (settling === 0) return undefined;
    const timer = setTimeout(() => {
      setSettling(0);
    }, settleFor);
    return () => {
      clearTimeout(timer);
    };
  }, [settling]);

  useEffect(() => {
    if (paused) return undefined;
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refresh, interval);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, paused]);

  return (
    <p role="status" data-settling={settling > 0 ? "" : undefined} className="sr-only">
      {announcement}
    </p>
  );
}
