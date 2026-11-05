"use client";

import { useFormStatus } from "react-dom";

/** Says a run started to a screen reader, because a model call can take minutes. Goes in the run's form. */
export function RunStatus({ name }: { name: string }) {
  const { pending } = useFormStatus();
  return (
    <p role="status" className="sr-only">
      {pending ? `Running ${name}` : ""}
    </p>
  );
}
