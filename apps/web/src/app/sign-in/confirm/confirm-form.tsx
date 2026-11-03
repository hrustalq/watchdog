"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A plain GET form, so the browser itself receives Better Auth's Set-Cookie and redirect. That's
 * also why it doesn't use SubmitButton: useFormStatus only tracks function actions. After a press
 * the button stays disabled, because a second press would land on the "expired" notice. It keeps
 * focus meanwhile, so a screen reader hears the new label.
 */
export function ConfirmForm({ action, fields }: { action: string; fields: Record<string, string> }) {
  const [pressed, setPressed] = useState(false);
  // Back from the Workspace can restore this page as it was left, pressed. Make it usable again.
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setPressed(false);
    };
    window.addEventListener("pageshow", reset);
    return () => {
      window.removeEventListener("pageshow", reset);
    };
  }, []);
  return (
    <form
      method="get"
      action={action}
      onSubmit={() => {
        setPressed(true);
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" className="w-full" disabled={pressed} focusableWhenDisabled>
        {pressed ? "Signing in…" : "Sign in to Watchdog"}
      </Button>
    </form>
  );
}
