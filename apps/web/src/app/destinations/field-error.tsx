"use client";

import { useEffect, useRef } from "react";
import { fieldError } from "@/components/field-classes";

/**
 * A problem with a field, which the page arrives with. After a redirect Next scrolls the page back to the
 * top, once autoFocus has already scrolled to the field, so this brings the message back into view.
 * Without JavaScript the browser's own autofocus does that.
 */
export function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  // A block body: Chrome's scrollIntoView returns a promise, which React would call as the cleanup.
  useEffect(() => {
    ref.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return (
    <p ref={ref} id={id} role="alert" className={fieldError}>
      {children}
    </p>
  );
}
