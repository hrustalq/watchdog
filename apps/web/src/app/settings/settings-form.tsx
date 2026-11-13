"use client";

import { useRef, useState } from "react";
import type { AlertSettingsForm } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { saveSettingsAction } from "./actions";

interface SettingsFormProps {
  /**
   * The values the fields start from: what's saved, or what a refused save posted back. A refused form
   * arrived with the values it shows, so it doesn't claim changes of its own.
   */
  initial: AlertSettingsForm;
  /** The last save went through, so its notice is the first thing the form says. */
  justSaved: boolean;
  children: React.ReactNode;
}

/**
 * The Settings form, which says when its fields differ from what's saved, as the Profile form does.
 * Its fields come from the server, so it reads their values from the form on an `input` or `change`
 * rather than holding each one. Without JavaScript nothing here runs: it's the form it was, with no
 * unsaved state, and the notice after a save.
 */
export function SettingsForm({ initial, justSaved, children }: SettingsFormProps) {
  const form = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(false);
  const check = () => {
    const element = form.current;
    if (element !== null) setDirty(differs(element, initial));
  };

  return (
    <form
      ref={form}
      action={saveSettingsAction}
      onInput={check}
      onChange={check}
      className="flex flex-col gap-6"
    >
      {justSaved ? (
        // Each save brings a new page, so the notice is a new node and is read again, even when the
        // fields went nowhere. Hidden, not removed, while the fields hold edits: putting them back
        // returns it.
        <Notice role="status" className={cn("rounded-lg bg-muted px-3 py-2 text-sm", dirty && "hidden")}>
          Settings saved. The next alert follows them.
        </Notice>
      ) : null}

      {children}

      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {dirty ? <strong className="font-medium text-foreground">Unsaved changes. </strong> : null}A saved change
          applies to the next alert, including ones already waiting.
        </p>
        <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start">
          Save settings
        </SubmitButton>
      </div>
    </form>
  );
}

/** Whether the fields, as they stand, are not the ones the form started from. */
function differs(form: HTMLFormElement, initial: AlertSettingsForm) {
  // The form as it would post, so each kind of field reads the way it saves: a box as on or not, and
  // the rest as the text it holds.
  const data = new FormData(form);
  const text = (name: string) => {
    const value = data.get(name);
    return typeof value === "string" ? value : "";
  };
  return (
    text("timezone") !== initial.timezone ||
    data.has("quietHours") !== initial.quietHours ||
    text("quietHoursStart") !== initial.quietHoursStart ||
    text("quietHoursEnd") !== initial.quietHoursEnd ||
    data.has("severity5Bypasses") !== initial.severity5Bypasses ||
    text("alertsPerHour") !== initial.alertsPerHour ||
    text("burstWindowSeconds") !== initial.burstWindowSeconds
  );
}
