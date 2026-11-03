"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * A notice the page arrives with, such as an expired link. A live region isn't announced when it's
 * there from the first render, so focus moves to the notice and screen readers read it then.
 */
export function Notice({
  children,
  role,
  className,
}: {
  children: React.ReactNode;
  role: "alert" | "status";
  className: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => ref.current?.focus(), []);
  // Focusable only from code, and it isn't interactive, so it shows no focus ring.
  return (
    <p ref={ref} role={role} tabIndex={-1} className={cn("outline-none", className)}>
      {children}
    </p>
  );
}
