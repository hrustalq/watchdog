"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Disabled while its form is submitting, so a second click doesn't send a second link or start a
 * second sign-in.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant,
  className,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: "default" | "outline" | "destructive";
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} className={cn("w-full", className)} disabled={pending}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
