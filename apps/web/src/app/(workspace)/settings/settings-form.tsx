"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Notice } from "@/components/notice";
import { SubmitButton } from "@/components/submit-button";

interface SettingsFormProps {
  /**
   * The Server Action this tab's button posts. It comes from the page rather than from this module,
   * so one form serves the Delivery tab and the Retention tab, and each redirects to its own tab.
   */
  action: (formData: FormData) => Promise<void>;
  /**
   * The values the fields start from: what's saved, or what a refused save posted back, and only the
   * active tab's fields. A field the tab doesn't show can't make the form read as changed.
   */
  initial: Readonly<Record<string, string | boolean>>;
  /** What this tab says after its own save, or none. A notice never crosses to another tab. */
  notice?: string | undefined;
  /** What the line above the button says about when the save applies, and the button's own words. */
  note: string;
  submitLabel: string;
  children: React.ReactNode;
}

/**
 * A Settings tab's form, which says when its fields differ from what's saved, as the Profile form
 * does. Its fields come from the server, so it reads their values from the form on an `input` or
 * `change` rather than holding each one. Without JavaScript nothing here runs: it's the form it was,
 * with no unsaved state, and the notice after a save.
 */
export function SettingsForm({ action, initial, notice, note, submitLabel, children }: SettingsFormProps) {
  const form = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(false);
  const check = () => {
    const element = form.current;
    if (element !== null) setDirty(differs(element, initial));
  };

  return (
    <form ref={form} action={action} onInput={check} onChange={check} className="flex flex-col gap-6">
      {notice === undefined ? null : (
        // Each save brings a new page, so the notice is a new node and is read again, even when the
        // fields went nowhere. Hidden, not removed, while the fields hold edits: putting them back
        // returns it.
        <Notice role="status" className={cn(dirty && "hidden")}>
          {notice}
        </Notice>
      )}

      {children}

      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          {dirty ? <strong className="font-medium text-foreground">Unsaved changes. </strong> : null}
          {note}
        </p>
        <SubmitButton pendingLabel="Saving…" className="sm:w-auto sm:self-start">
          {submitLabel}
        </SubmitButton>
      </div>
    </form>
  );
}

/** What the form holds for a field, as text: a missing one reads as empty. */
function textOf(data: FormData, name: string) {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

/** Whether this tab's fields, as they stand, are not the ones the form started from. */
function differs(form: HTMLFormElement, initial: Readonly<Record<string, string | boolean>>) {
  // The form as it would post, so each kind of field reads the way it saves: a box as on or not, and
  // the rest as the text it holds.
  const data = new FormData(form);
  return Object.entries(initial).some(([name, value]) =>
    typeof value === "boolean" ? data.has(name) !== value : textOf(data, name) !== value,
  );
}
