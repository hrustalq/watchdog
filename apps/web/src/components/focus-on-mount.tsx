"use client";

import { useEffect } from "react";

/**
 * Focuses the element with this id once the page has arrived. A Server Action's redirect renders the
 * screen again and the button that had focus goes with it, so the action names the Source it acted on
 * and this puts the focus back near it instead of at the top of the page. The id, not a ref, because
 * the element it lands on is rendered by the server, a row away.
 */
export function FocusOnMount({ id }: { id: string }) {
  useEffect(() => {
    document.getElementById(id)?.focus();
  }, [id]);
  return null;
}
