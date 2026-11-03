"use client";

import { useActionState } from "react";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { addSource, type AddSourceState } from "./actions";

const field =
  "h-8 w-full rounded-lg border border-input bg-transparent px-3 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/40 sm:text-sm";
const label = "text-xs font-medium tracking-[0.01em]";
const fieldError = "text-xs font-medium tracking-[0.01em] text-alarm";

/**
 * Adds an RSS Source. The server fetches the feed before saving it, and an error comes back on the
 * field it's about. Without JavaScript the form posts and the page renders with the same state.
 */
export function AddSourceForm({
  schedules,
  defaultSchedule,
}: {
  schedules: { cron: string; label: string }[];
  defaultSchedule: string;
}) {
  const initial: AddSourceState = { attempt: 0, values: { url: "", name: "", schedule: defaultSchedule } };
  const [state, action] = useActionState(addSource, initial);
  const { values, error } = state;
  const invalid = (name: "url" | "schedule") => error?.field === name;

  return (
    <form key={state.attempt} action={action} className="flex flex-col gap-4">
      {state.added === undefined ? null : (
        <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
          Added {state.added}. The worker fetches it within a minute, and its recent entries show up
          in the Feed as the Backfill.
        </Notice>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor="url" className={label}>
          RSS feed URL
        </label>
        <input
          id="url"
          name="url"
          type="url"
          required
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder="https://example.com/feed.xml"
          defaultValue={values.url}
          aria-invalid={invalid("url")}
          aria-describedby={invalid("url") ? "url-error" : "url-help"}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
          autoFocus={invalid("url")}
          className={field}
        />
        {invalid("url") ? (
          <p id="url-error" role="alert" className={fieldError}>
            {error?.message}
          </p>
        ) : (
          <p id="url-help" className="text-xs text-muted-foreground">
            The address of an RSS or Atom feed. Watchdog fetches it once to check it before saving.
          </p>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <label htmlFor="name" className={label}>
            Name <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            id="name"
            name="name"
            type="text"
            maxLength={200}
            placeholder="The feed's own title"
            defaultValue={values.name}
            className={field}
          />
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="schedule" className={label}>
            Schedule
          </label>
          <select
            id="schedule"
            name="schedule"
            defaultValue={values.schedule}
            aria-invalid={invalid("schedule")}
            aria-describedby={invalid("schedule") ? "schedule-error" : undefined}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
            autoFocus={invalid("schedule")}
            className={`${field} bg-background`}
          >
            {schedules.map((schedule) => (
              <option key={schedule.cron} value={schedule.cron}>
                {schedule.label}
              </option>
            ))}
          </select>
          {invalid("schedule") ? (
            <p id="schedule-error" role="alert" className={fieldError}>
              {error?.message}
            </p>
          ) : null}
        </div>
      </div>
      <SubmitButton pendingLabel="Checking the feed…" className="sm:w-auto sm:self-start">
        Add Source
      </SubmitButton>
    </form>
  );
}
