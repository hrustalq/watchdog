"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * A plain GET form, so the browser itself receives Better Auth's Set-Cookie and redirect. Without
 * fields (the static shell) the button is disabled. After a press it stays disabled, because a
 * second press would spend nothing and land on the "expired" notice.
 */
export function ConfirmForm({ action, fields }: { action?: string; fields?: Record<string, string> }) {
  const [pressed, setPressed] = useState(false);
  return (
    <form method="get" action={action} onSubmit={() => {
        setPressed(true);
      }}>
      {Object.entries(fields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Button type="submit" className="w-full" disabled={fields === undefined || pressed}>
        {pressed ? "Signing in…" : "Sign in to Watchdog"}
      </Button>
    </form>
  );
}
