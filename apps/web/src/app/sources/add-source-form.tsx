import type { ComponentProps, ReactNode } from "react";
import { dataBox, field, fieldError, label, textBox } from "@/components/field-classes";
import type { Config } from "@watchdog/core";
import { type AddType, type AddValues, schedules } from "@/lib/sources";
import { cn } from "@/lib/utils";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { addSource } from "./actions";

const types: { value: AddType; title: string }[] = [
  { value: "rss", title: "RSS feed" },
  { value: "website", title: "Website" },
  { value: "github-releases", title: "GitHub releases" },
  { value: "github-issues", title: "GitHub issues" },
  { value: "github-mentions", title: "GitHub mentions" },
];

type FieldName = "url" | "region" | "ignore" | "repo" | "term" | "within" | "token" | "schedule";

// Each type's fields show while its choice is checked, which CSS decides, so it works without
// JavaScript. No field is `required`, and the URL isn't `type="url"`: a hidden field the browser
// finds invalid would block the submit. Tailwind needs each class written out whole.
const shownFor = {
  // Shown unless another type is checked, so RSS still works in a browser without :has(). A website
  // uses it too.
  url: "flex [form:has(#type-github-releases:checked)_&]:hidden [form:has(#type-github-issues:checked)_&]:hidden [form:has(#type-github-mentions:checked)_&]:hidden",
  repo: "[form:has(#type-github-releases:checked)_&]:flex [form:has(#type-github-issues:checked)_&]:flex",
  search: "[form:has(#type-github-mentions:checked)_&]:flex",
  website: "[form:has(#type-website:checked)_&]:flex",
  token: "[form:has(#type-github-issues:checked)_&]:flex [form:has(#type-github-mentions:checked)_&]:flex",
};

const empty: AddValues = {
  type: "rss",
  url: "",
  region: "",
  ignore: "",
  ignoreRobots: "",
  repo: "",
  term: "",
  within: "",
  name: "",
  schedule: "",
};

/**
 * Adds an RSS feed, a website, a GitHub repo's releases or issues, or a GitHub search. The server
 * checks a feed or releases before saving it, and a problem comes back on the field it's about, with
 * the values that were entered. A pasted token is never sent back.
 */
export function AddSourceForm({
  values = empty,
  error,
  added = false,
  tokenDropped = false,
  githubSignIn,
  mode,
}: {
  values?: AddValues;
  error?: { field: FieldName; message: string };
  added?: boolean;
  /** A token was pasted with a submit that came back with a problem; it is never sent back. */
  tokenDropped?: boolean;
  /** Whether the Workspace's owner signed in with GitHub; unknown in the static shell. */
  githubSignIn?: boolean;
  /** Only self-hosted offers to skip robots.txt (ADR 0015); unknown in the static shell. */
  mode?: Config["mode"];
}) {
  const errorFor = (name: FieldName) => (error?.field === name ? error.message : undefined);
  return (
    <form action={addSource} className="flex flex-col gap-4">
      {added ? (
        <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
          {addedNotice(values.type)}
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
        label={
          <>
            <span className="[form:has(#type-website:checked)_&]:hidden">RSS feed URL</span>
            <span className="hidden [form:has(#type-website:checked)_&]:inline">Page URL</span>
          </>
        }
        className={shownFor.url}
        error={errorFor("url")}
        help={
          <>
            <span className="[form:has(#type-website:checked)_&]:hidden">
              The address of an RSS or Atom feed. Watchdog fetches it once to check it before saving.
            </span>
            <span className="hidden [form:has(#type-website:checked)_&]:inline">
              The page to watch. Watchdog reads its HTML as served, without running its scripts.
            </span>
          </>
        }
        inputMode="url"
        autoComplete="url"
        placeholder="https://example.com/"
        defaultValue={values.url}
      />
      <TextField
        id="region"
        label="Region"
        optional
        className={shownFor.website}
        error={errorFor("region")}
        help="A CSS selector for the part of the page to watch, such as #pricing .plan. Every match counts. Leave it empty to watch the whole page."
        autoCapitalize="off"
        autoComplete="off"
        placeholder="main"
        maxLength={1000}
        defaultValue={values.region}
        inputClassName={dataBox}
      />
      <div className={cn("hidden flex-col gap-2", shownFor.website)}>
        <label htmlFor="ignore" className={label}>
          Ignore <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id="ignore"
          name="ignore"
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder={"\\d+ visitors today\nUpdated .* ago"}
          defaultValue={values.ignore}
          aria-invalid={error?.field === "ignore"}
          aria-describedby={error?.field === "ignore" ? "ignore-error" : "ignore-help"}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
          autoFocus={error?.field === "ignore"}
          className={cn(textBox, dataBox, "py-2 leading-[1.5]")}
        />
        {error?.field === "ignore" ? (
          <p id="ignore-error" role="alert" className={fieldError}>
            {error.message}
          </p>
        ) : (
          <p id="ignore-help" className="text-xs text-muted-foreground">
            Text that changes without mattering, such as a date or a counter, as regular expressions in RE2 syntax,
            one a line, at most 20. Watchdog removes what they match before comparing.
          </p>
        )}
      </div>
      {mode === "self-hosted" ? (
        <div className={cn("hidden flex-col gap-2", shownFor.website)}>
          {/* The label holds the box, so the whole row is the target. */}
          <label htmlFor="ignoreRobots" className={cn(label, "flex min-h-6 items-center gap-2")}>
            <input
              id="ignoreRobots"
              name="ignoreRobots"
              type="checkbox"
              defaultChecked={values.ignoreRobots === "on"}
              aria-describedby="ignoreRobots-help"
              className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            />
            Ignore robots.txt
          </label>
          <p id="ignoreRobots-help" className="text-xs text-muted-foreground">
            Watchdog then fetches the page even where the site&apos;s robots.txt asks crawlers not to. The site may
            object or block this server&apos;s address, and that risk is yours.
          </p>
        </div>
      ) : null}
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
        help="Words or a phrase, as GitHub's search reads them. Each poll reads only the newest 100 matching issues and pull requests, so narrow a busy term."
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
        optional={githubSignIn !== false}
        className={shownFor.token}
        error={errorFor("token")}
        help={
          tokenDropped ? (
            "Paste the token again: Watchdog never sends it back to the page."
          ) : (
            <>
              {githubSignIn === false
                ? "Required: this Workspace has no GitHub sign-in to read the API with. "
                : null}
              <span className="[form:has(#type-github-mentions:checked)_&]:hidden">
                A fine-grained personal access token that can read the repo&apos;s issues, needed for a
                private repo.
              </span>
              <span className="hidden [form:has(#type-github-mentions:checked)_&]:inline">
                A fine-grained personal access token, which also searches the private repos it can read.
              </span>{" "}
              Stored encrypted and never shown again.
            </>
          )
        }
        // A password field: the browser doesn't show it or keep it in form history.
        type="password"
        autoComplete="off"
        // Password managers ignore autocomplete="off" on a password field; these ask them to stay out.
        data-1p-ignore
        data-lpignore="true"
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
            placeholder="Taken from the feed, page, repo or search"
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

/** What happens after an add, which depends on how the type's first poll goes. */
function addedNotice(type: AddType) {
  if (type === "website") {
    return "Source added. Its first poll, within a minute, keeps the page as the Baseline. Each change after that shows up in the Feed as one Item. If the page can't be read, its row below says why.";
  }
  if (type === "github-issues" || type === "github-mentions") {
    return "Source added. Its first poll runs within a minute, and its recent entries show up in the Feed as the Backfill. If none do, its row below says why.";
  }
  return "Source added. The worker fetches it within a minute, and its recent entries show up in the Feed as the Backfill.";
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
  label: ReactNode;
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
