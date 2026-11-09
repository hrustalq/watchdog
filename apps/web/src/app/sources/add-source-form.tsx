import { dataBox, field, fieldError, label } from "@/components/field-classes";
import { type AddType, type AddValues, schedules } from "@/lib/sources";
import { cn } from "@/lib/utils";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { addSource } from "./actions";

const types: { value: AddType; title: string }[] = [
  { value: "rss", title: "RSS feed" },
  { value: "github-releases", title: "GitHub releases" },
];

// Each type's field shows while its choice is checked, which CSS decides, so it works without
// JavaScript. Neither field is `required`, and the URL isn't `type="url"`: a hidden field the
// browser finds invalid would block the submit.

/**
 * Adds an RSS Source or a GitHub releases Source. The server fetches the feed before saving it,
 * and a problem comes back on the field it's about, with the values that were entered.
 */
export function AddSourceForm({
  values = { type: "rss", url: "", repo: "", name: "", schedule: "" },
  error,
  added = false,
}: {
  values?: AddValues;
  error?: { field: "url" | "repo" | "schedule"; message: string };
  added?: boolean;
}) {
  const invalid = (name: "url" | "repo" | "schedule") => error?.field === name;
  return (
    <form action={addSource} className="flex flex-col gap-4">
      {added ? (
        <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
          Source added. The worker fetches it within a minute, and its recent entries show up in the
          Feed as the Backfill.
        </Notice>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className={cn(label, "mb-2")}>Type</legend>
        <div className="flex flex-wrap gap-1">
          {types.map((type) => (
            <label
              key={type.value}
              // Forced colors drop the fill, which would leave the two choices looking the same.
              className="inline-flex h-8 cursor-pointer items-center rounded-lg border border-transparent px-3 text-sm font-medium select-none hover:bg-muted has-checked:bg-primary has-checked:text-primary-foreground has-checked:hover:bg-primary/80 has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/30 dark:hover:bg-muted/50 forced-colors:has-checked:bg-[Highlight] forced-colors:has-checked:text-[HighlightText] forced-colors:has-checked:forced-color-adjust-none"
            >
              <input
                type="radio"
                id={`type-${type.value}`}
                name="type"
                value={type.value}
                defaultChecked={values.type === type.value}
                className="sr-only"
              />
              {type.title}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-col gap-2 [form:has(#type-github-releases:checked)_&]:hidden">
        <label htmlFor="url" className={label}>
          RSS feed URL
        </label>
        <input
          id="url"
          name="url"
          type="text"
          inputMode="url"
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
      <div className="hidden flex-col gap-2 [form:has(#type-github-releases:checked)_&]:flex">
        <label htmlFor="repo" className={label}>
          Repo
        </label>
        <input
          id="repo"
          name="repo"
          type="text"
          autoCapitalize="off"
          autoComplete="off"
          spellCheck={false}
          placeholder="vercel/next.js"
          defaultValue={values.repo}
          aria-invalid={invalid("repo")}
          aria-describedby={invalid("repo") ? "repo-error" : "repo-help"}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
          autoFocus={invalid("repo")}
          className={cn(field, dataBox)}
        />
        {invalid("repo") ? (
          <p id="repo-error" role="alert" className={fieldError}>
            {error?.message}
          </p>
        ) : (
          <p id="repo-help" className="text-xs text-muted-foreground">
            A public repo, as owner/name or its github.com URL. Watchdog reads its releases once to
            check it before saving.
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
            placeholder="Taken from the feed or repo"
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
      <SubmitButton pendingLabel="Checking…" className="sm:w-auto sm:self-start">
        Add Source
      </SubmitButton>
    </form>
  );
}
