"use client";

import { useState } from "react";
import { SubmitButton } from "../sign-in/submit-button";
import { testModelSettingsAction } from "./actions";

/**
 * The Model form's two submits, in one form: what it holds is tried without being saved, or saved.
 * Only the button someone pressed says what it's doing, so a test never reads as a save; a press of
 * Enter submits the form's own action, which is the save.
 */
export function ModelFormActions() {
  const [pressed, setPressed] = useState<"save" | "test">("save");
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row">
        <SubmitButton
          pendingLabel="Saving…"
          showPendingLabel={pressed === "save"}
          onClick={() => {
            setPressed("save");
          }}
          className="sm:w-auto"
        >
          Save model
        </SubmitButton>
        <SubmitButton
          pendingLabel="Testing…"
          showPendingLabel={pressed === "test"}
          formAction={testModelSettingsAction}
          variant="outline"
          onClick={() => {
            setPressed("test");
          }}
          className="sm:w-auto"
        >
          Test these settings
        </SubmitButton>
      </div>
      <p className="text-xs text-muted-foreground">
        A test makes one small call with the settings above, which your provider bills as usual, and saves nothing.
      </p>
    </div>
  );
}
