import { field, fieldError, label } from "@/components/field-classes";
import { schedules } from "@/lib/sources";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { addSource } from "./actions";

/**
 * Adds an RSS Source. The server fetches the feed before saving it, and a problem comes back on
 * the field it's about, with the values that were entered.
 */
export function AddSourceForm({
  values = { url: "", name: "", schedule: "" },
  error,
  added = false,
}: {
  values?: { url: string; name: string; schedule: string };
  error?: { field: "url" | "schedule"; message: string };
  added?: boolean;
}) {
  const invalid = (name: "url" | "schedule") => error?.field === name;
  return (
    <form action={addSource} className="flex flex-col gap-4">
      {added ? (
        <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
          Source added. The worker fetches it within a minute, and its recent entries show up in the
          Feed as the Backfill.
        </Notice>
      ) : null}
      <div className="flex flex-col gap-2">
        <label htmlFor="url" className={label}>
          RSS feed URL
        </label>
        <input
          id="url"
          name="url"
          type="url"
          required
          autoComplete="url"
          spellCheck={false}
          placeholder="https://example.com/feed.xml"
          defaultValue={values.url}
          aria-invalid={invalid("url")}
          aria-describedby={invalid("url") ? "url-error" : "url-help"}
          // Focus lands here with the error, so the field and its message are read together.
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
