"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Disabled while its form is submitting, so a second click doesn't send a second link or start a
 * second sign-in. `formAction` gives one form two submits, as the Model form's save and test do.
 */
export function SubmitButton({
  children,
  pendingLabel,
  variant,
  className,
  formAction,
  onClick,
  showPendingLabel = true,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: "default" | "outline" | "destructive";
  className?: string;
  formAction?: (formData: FormData) => void | Promise<void>;
  onClick?: () => void;
  /**
   * False for the other submit of a form that has two: it's the form that's busy, with work that
   * isn't this button's, so it goes quiet rather than wearing a label for what someone else began.
   */
  showPendingLabel?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      formAction={formAction}
      onClick={onClick}
      variant={variant}
      className={cn("w-full", className)}
      disabled={pending}
    >
      {pending && showPendingLabel ? pendingLabel : children}
    </Button>
  );
}
