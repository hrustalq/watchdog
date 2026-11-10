"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** How often the Sources screen looks again while a poll is due. */
const interval = 5_000;

/**
 * Re-renders the Sources screen from the server while a Source's poll is due and the tab is visible, so
 * the row shows how the poll went without a reload. The page renders it only while a poll is due.
 */
export function DueRefresher() {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, interval);
    return () => {
      clearInterval(timer);
    };
  }, [router]);
  return null;
}
