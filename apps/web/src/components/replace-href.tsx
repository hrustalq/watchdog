"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Corrects a URL that named a step the page couldn't run, once React has hydrated. It is only an
 * address tidy-up: the page already rendered the earliest step that can, so a browser without
 * JavaScript still gets that step's content and form. The normalized href has no extra state, so a
 * replace can't loop.
 */
export function ReplaceHref({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(href);
  }, [href, router]);
  return null;
}
