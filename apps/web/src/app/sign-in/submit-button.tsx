"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/**
 * Disabled while its form is submitting, so a second click doesn't send a second link or start a
 * second sign-in.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: "default" | "outline";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} className="w-full" disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
