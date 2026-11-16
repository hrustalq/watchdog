"use client";

import { useEffect } from "react";
import { forgetDraft } from "@/lib/draft";

/**
 * Forgets the editor's drafts when the Rules screen opens, because every save lands here. A saved
 * rule's editor already finds what it kept saved, but a new rule has no editor to return to, and its
 * draft would otherwise come back the next time one is started.
 */
export function ForgetDrafts({ prefix }: { prefix: string }) {
  useEffect(() => {
    forgetDraft(prefix);
  }, [prefix]);
  return null;
}
