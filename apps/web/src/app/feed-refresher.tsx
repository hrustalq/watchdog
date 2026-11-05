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
 * clicks for a moment, so a second click at the same spot can't correct a different Item.
 */
export function FeedRefresher({ ids }: { ids: string[] }) {
  const router = useRouter();
  const [shown, setShown] = useState(ids);
  const [announcement, setAnnouncement] = useState("");
  const [settling, setSettling] = useState(false);

  // Every refresh brings a new array, so this runs once per refresh, during render.
  if (ids !== shown) {
    setShown(ids);
    const arrived = ids.filter((id) => !shown.includes(id)).length;
    // Cleared when nothing arrived, so the same count next time is a change screen readers announce.
    setAnnouncement(arrived === 0 ? "" : `${String(arrived)} new ${arrived === 1 ? "Item" : "Items"} in the Feed`);
    if (ids.join() !== shown.join()) setSettling(true);
  }

  useEffect(() => {
    if (!settling) return undefined;
    const timer = setTimeout(() => {
      setSettling(false);
    }, settleFor);
    return () => {
      clearTimeout(timer);
    };
  }, [settling]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(refresh, interval);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router]);

  return (
    <p role="status" data-settling={settling ? "" : undefined} className="sr-only">
      {announcement}
    </p>
  );
}
