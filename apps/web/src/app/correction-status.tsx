"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** How long the result stays, so the same result next time is a change screen readers announce. */
const resultFor = 5_000;

/**
 * A button in a Correction's form. It posts a level worked out from what the page shows, so it does
 * nothing while a save is on the way and that level is out of date. It stays focusable meanwhile.
 */
export function CorrectionButton({ type, ...props }: React.ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return <Button type={pending ? "button" : type} {...props} />;
}

/**
 * Goes in a Correction's form. It tells a screen reader where the Correction left things, which is true
 * even when nothing changed, and `data-pending` lets the form dim while it's saving. When the control
 * that had focus is gone, focus comes here, so a screen reader keeps its place.
 */
export function CorrectionStatus({ result }: { result: string }) {
  const { pending } = useFormStatus();
  const [started, setStarted] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  if (pending && !started) setStarted(true);

  useEffect(() => {
    if (pending || !started) return undefined;
    if (document.activeElement === document.body) ref.current?.focus({ preventScroll: true });
    const timer = setTimeout(() => {
      setStarted(false);
    }, resultFor);
    return () => {
      clearTimeout(timer);
    };
  }, [pending, started]);

  return (
    <p ref={ref} role="status" tabIndex={-1} data-pending={pending ? "" : undefined} className="sr-only">
      {pending ? "Saving the Correction" : null}
      {!pending && started ? result : null}
    </p>
  );
}
