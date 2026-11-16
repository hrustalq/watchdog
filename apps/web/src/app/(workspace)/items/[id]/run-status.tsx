"use client";

import { useFormStatus } from "react-dom";

/**
 * Says a run started to a screen reader, because a model call can take minutes. Goes in the run's form.
 * `data-pending` marks the form as saving while it runs, which holds the page's refresh, so a run in
 * progress and its notice aren't replaced while the user waits for it.
 */
export function RunStatus({ name }: { name: string }) {
  const { pending } = useFormStatus();
  return (
    <p role="status" data-pending={pending ? "" : undefined} className="sr-only">
      {pending ? `Running ${name}` : ""}
    </p>
  );
}
