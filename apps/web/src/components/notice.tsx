"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

const tones = {
  /** A well on the page: news, or a fact the screen arrived with. */
  quiet: "rounded-lg bg-muted px-3 py-2 text-sm",
  /** The alarm-red well: a refusal or a failure. Never a solid red slab. */
  failed: "rounded-lg bg-destructive/10 px-3 py-2 text-sm text-alarm",
  /** The caution well: something that needs attention but isn't broken, such as a rule that found nothing. */
  caution: "rounded-lg bg-caution/10 px-3 py-2 text-sm text-caution",
  /** No fill, for a notice inside a panel that must not nest a second well. */
  plain: "text-sm",
  /** No fill and Alarm Red words: a refusal stated inside a panel that already has a surface. */
  alarm: "text-sm text-alarm",
} as const;

/**
 * A notice the page arrives with, such as an expired link. A live region isn't announced when it's
 * there from the first render, so focus moves to the notice and screen readers read it then. `tone`
 * is its look, not its meaning: `role` is what makes a screen reader interrupt, so a refusal is
 * `role="alert"` with `tone="failed"`, news is `role="status"` with the default, a caution
 * is `role="status"` with `tone="caution"`, and `alarm` is the same red with no fill inside a panel. `plain` keeps
 * running text inside a panel from gaining a second inset well; it is the only tone whose color the
 * caller sets.
 */
export function Notice({
  children,
  role,
  tone = "quiet",
  className,
}: {
  children: React.ReactNode;
  role: "alert" | "status";
  tone?: keyof typeof tones;
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => ref.current?.focus(), []);
  // Focusable only from code, and it isn't interactive, so it shows no focus ring.
  return (
    <p ref={ref} role={role} tabIndex={-1} className={cn("outline-hidden", tones[tone], className)}>
      {children}
    </p>
  );
}
