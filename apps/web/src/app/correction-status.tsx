"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";

/**
 * Goes in a Correction's form. It tells a screen reader how the Correction went, since the page changes
 * without moving focus, and `data-pending` lets the form dim while it's saving.
 */
export function CorrectionStatus() {
  const { pending } = useFormStatus();
  const [started, setStarted] = useState(false);
  if (pending && !started) setStarted(true);
  return (
    <p role="status" data-pending={pending ? "" : undefined} className="sr-only">
      {pending ? "Saving the Correction" : null}
      {!pending && started ? "Correction saved" : null}
    </p>
  );
}
