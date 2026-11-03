"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** How often an open Feed checks for new Items. */
const interval = 30_000;

/**
 * Re-renders the Feed from the server every 30 seconds while the tab is visible, and once when it
 * becomes visible again, so new Items appear without a reload. Screen readers hear how many arrived.
 */
export function FeedRefresher({ ids }: { ids: string[] }) {
  const router = useRouter();
  const [shown, setShown] = useState(ids);
  const [announcement, setAnnouncement] = useState("");

  // Every refresh brings a new array, so this runs once per refresh, during render.
  if (ids !== shown) {
    setShown(ids);
    const arrived = ids.filter((id) => !shown.includes(id)).length;
    // Cleared when nothing arrived, so the same count next time is a change screen readers announce.
    setAnnouncement(arrived === 0 ? "" : `${String(arrived)} new ${arrived === 1 ? "Item" : "Items"} in the Feed`);
  }

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
    <p role="status" className="sr-only">
      {announcement}
    </p>
  );
}
