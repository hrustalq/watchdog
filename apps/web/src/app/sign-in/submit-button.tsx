"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** Disabled while the link is sending, so a second click doesn't send a second link. */
export function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Sending link…" : "Email me a sign-in link"}
    </Button>
  );
}
