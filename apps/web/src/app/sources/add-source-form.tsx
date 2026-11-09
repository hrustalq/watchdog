import type { ComponentProps, ReactNode } from "react";
import { dataBox, field, fieldError, label } from "@/components/field-classes";
import { type AddType, type AddValues, schedules } from "@/lib/sources";
import { cn } from "@/lib/utils";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { addSource } from "./actions";

const types: { value: AddType; title: string }[] = [
  { value: "rss", title: "RSS feed" },
  { value: "github-releases", title: "GitHub releases" },
  { value: "github-issues", title: "GitHub issues" },
  { value: "github-mentions", title: "GitHub mentions" },
];

type FieldName = "url" | "repo" | "term" | "within" | "token" | "schedule";

// Each type's fields show while its choice is checked, which CSS decides, so it works without
// JavaScript. No field is `required`, and the URL isn't `type="url"`: a hidden field the browser
// finds invalid would block the submit. Tailwind needs each class written out whole.
const shownFor = {
  // Shown unless another type is checked, so RSS still works in a browser without :has().
  url: "flex [form:has(#type-github-releases:checked)_&]:hidden [form:has(#type-github-issues:checked)_&]:hidden [form:has(#type-github-mentions:checked)_&]:hidden",
  repo: "[form:has(#type-github-releases:checked)_&]:flex [form:has(#type-github-issues:checked)_&]:flex",
  search: "[form:has(#type-github-mentions:checked)_&]:flex",
  token: "[form:has(#type-github-issues:checked)_&]:flex [form:has(#type-github-mentions:checked)_&]:flex",
};

/**
 * Adds an RSS feed, or a GitHub repo's releases or issues, or a GitHub search. The server checks a
 * feed or releases before saving it, and a problem comes back on the field it's about, with the
 * values that were entered. A pasted token is never sent back.
 */
export function AddSourceForm({
  values = { type: "rss", url: "", repo: "", term: "", within: "", name: "", schedule: "" },
  error,
  added = false,
}: {
  values?: AddValues;
  error?: { field: FieldName; message: string };
  added?: boolean;
}) {
  const errorFor = (name: FieldName) => (error?.field === name ? error.message : undefined);
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
              // Forced colors drop the fill, which would leave the choices looking the same.
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
      <TextField
        id="url"
        label="RSS feed URL"
        className={shownFor.url}
        error={errorFor("url")}
        help="The address of an RSS or Atom feed. Watchdog fetches it once to check it before saving."
        inputMode="url"
        autoComplete="url"
        placeholder="https://example.com/feed.xml"
        defaultValue={values.url}
      />
      <TextField
        id="repo"
        label="Repo"
        className={shownFor.repo}
        error={errorFor("repo")}
        help={
          <>
            A repo, as owner/name or its github.com URL.
            <span className="[form:has(#type-github-issues:checked)_&]:hidden">
              {" "}
              It must be public: Watchdog reads its releases once to check it before saving.
            </span>
            <span className="hidden [form:has(#type-github-issues:checked)_&]:inline">
              {" "}
              Each poll captures the issues opened since the last one, not pull requests.
            </span>
          </>
        }
        autoCapitalize="off"
        autoComplete="off"
        placeholder="vercel/next.js"
        defaultValue={values.repo}
        inputClassName={dataBox}
      />
      <TextField
        id="term"
        label="Search for"
        className={shownFor.search}
        error={errorFor("term")}
        help="Words or a phrase, as GitHub's issue search reads them. Each poll reads the newest 100 issues and pull requests that match, so a busy term can miss some: narrow it, or limit where it searches."
        autoComplete="off"
        placeholder="hydration mismatch"
        defaultValue={values.term}
        maxLength={100}
      />
      <TextField
        id="within"
        label="Only in"
        optional
        className={shownFor.search}
        error={errorFor("within")}
        help="An org, or a repo as owner/name. Leave it empty to search all of public GitHub."
        autoCapitalize="off"
        autoComplete="off"
        placeholder="vercel or vercel/next.js"
        defaultValue={values.within}
        inputClassName={dataBox}
      />
      <TextField
        id="token"
        label="GitHub token"
        optional
        className={shownFor.token}
        error={errorFor("token")}
        help="A fine-grained personal access token that can read the repo's issues. Without one, Watchdog uses your GitHub sign-in, which reads public repos only. A pasted token is stored encrypted and never shown again."
        // A password field: the browser doesn't show it or keep it in form history.
        type="password"
        autoComplete="off"
        inputClassName={dataBox}
      />
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
            placeholder="Taken from the feed, repo or search"
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
            aria-invalid={error?.field === "schedule"}
            aria-describedby={error?.field === "schedule" ? "schedule-error" : undefined}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
            autoFocus={error?.field === "schedule"}
            className={`${field} bg-background`}
          >
            {schedules.map((schedule) => (
              <option key={schedule.cron} value={schedule.cron}>
                {schedule.label}
              </option>
            ))}
          </select>
          {error?.field === "schedule" ? (
            <p id="schedule-error" role="alert" className={fieldError}>
              {error.message}
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

/** A labelled text field, hidden unless `className` shows it, with its help or its error below. */
function TextField({
  id,
  label: text,
  optional = false,
  help,
  error,
  className,
  inputClassName,
  ...input
}: {
  id: FieldName;
  label: string;
  optional?: boolean;
  help: ReactNode;
  error: string | undefined;
  className: string;
  inputClassName?: string;
} & Omit<ComponentProps<"input">, "id" | "name" | "className">) {
  const invalid = error !== undefined;
  return (
    <div className={cn("hidden flex-col gap-2", className)}>
      <label htmlFor={id} className={label}>
        {text}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </label>
      <input
        type="text"
        spellCheck={false}
        {...input}
        id={id}
        name={id}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-error` : `${id}-help`}
        // Focus lands here with the error, so the field and its message are read together.
        // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
        autoFocus={invalid}
        className={cn(field, inputClassName)}
      />
      {invalid ? (
        <p id={`${id}-error`} role="alert" className={fieldError}>
          {error}
        </p>
      ) : (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  );
}
