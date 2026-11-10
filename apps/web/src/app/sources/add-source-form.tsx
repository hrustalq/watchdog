import type { ComponentProps, ReactNode } from "react";
import { dataBox, field, fieldError, label, textBox } from "@/components/field-classes";
import { type Config, maxRegionLength } from "@watchdog/core";
import { type AddType, type AddValues, type mappingFields, type Renderers, schedules } from "@/lib/sources";
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
  { value: "webhook", title: "Webhook inbox" },
];

const renders: { value: AddValues["render"]; title: string }[] = [
  { value: "static", title: "Static" },
  { value: "obscura", title: "Rendered" },
  { value: "chromium", title: "Rendered in Chromium" },
];

type FieldName =
  | "url"
  | "region"
  | "ignore"
  | "render"
  | "repo"
  | "term"
  | "within"
  | "token"
  | "schedule"
  | (typeof mappingFields)[number];

/**
 * A choice in a row of them, its radio hidden. Forced colors drop the fill, which would leave the
 * choices looking the same. A disabled one is dimmed and takes no pointer.
 */
const choice =
  "inline-flex h-8 cursor-pointer items-center rounded-lg border border-transparent px-3 text-sm font-medium select-none hover:bg-muted has-checked:bg-primary has-checked:text-primary-foreground has-checked:hover:bg-primary/80 has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/30 has-disabled:pointer-events-none has-disabled:opacity-50 dark:hover:bg-muted/50 forced-colors:has-checked:bg-[Highlight] forced-colors:has-checked:text-[HighlightText] forced-colors:has-checked:forced-color-adjust-none";

// Each type's fields show while its choice is checked, which CSS decides, so it works without
// JavaScript. No field is `required`, and the URL isn't `type="url"`: a hidden field the browser
// finds invalid would block the submit. Tailwind needs each class written out whole.
const shownFor = {
  // Shown unless another type is checked, so RSS still works in a browser without :has(). A website
  // uses it too.
  url: "flex [form:has(#type-github-releases:checked)_&]:hidden [form:has(#type-github-issues:checked)_&]:hidden [form:has(#type-github-mentions:checked)_&]:hidden [form:has(#type-webhook:checked)_&]:hidden",
  repo: "[form:has(#type-github-releases:checked)_&]:flex [form:has(#type-github-issues:checked)_&]:flex",
  search: "[form:has(#type-github-mentions:checked)_&]:flex",
  website: "[form:has(#type-website:checked)_&]:flex",
  token: "[form:has(#type-github-issues:checked)_&]:flex [form:has(#type-github-mentions:checked)_&]:flex",
  webhook: "[form:has(#type-webhook:checked)_&]:flex",
  // An inbox is pushed to, so it has no schedule.
  schedule: "flex [form:has(#type-webhook:checked)_&]:hidden",
};

const empty: AddValues = {
  type: "rss",
  url: "",
  region: "",
  ignore: "",
  ignoreRobots: "",
  render: "static",
  repo: "",
  term: "",
  within: "",
  mapTitle: "",
  mapBody: "",
  mapUrl: "",
  mapExternalId: "",
  name: "",
  schedule: "",
};

/** The inbox mapping's fields, each a JSONPath into the payload. */
const mappings: { id: (typeof mappingFields)[number]; label: string; placeholder: string; help: string }[] = [
  { id: "mapTitle", label: "Title", placeholder: "$.alert.title", help: "Without it, the title is “Webhook to” and the Source's name." },
  { id: "mapBody", label: "Body", placeholder: "$.alert.message", help: "Without it, the body is the whole JSON." },
  { id: "mapUrl", label: "URL", placeholder: "$.alert.url", help: "An http or https link the Item opens." },
  {
    id: "mapExternalId",
    label: "External ID",
    placeholder: "$.alert.id",
    help: "What makes two requests the same Item. Without it, the same body sent twice is one Item.",
  },
];

/**
 * Adds an RSS feed, a website, a GitHub repo's releases or issues, a GitHub search, or a webhook inbox. The server
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
  renderers,
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
  /** Which browsers this install runs to render a page; unknown in the static shell. */
  renderers?: Renderers;
}) {
  const errorFor = (name: FieldName) => (error?.field === name ? error.message : undefined);
  const offered = (render: AddValues["render"]) => render === "static" || renderers?.[render] !== false;
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
            <label key={type.value} className={choice}>
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
        websiteLabel="Page URL"
        className={shownFor.url}
        error={errorFor("url")}
        help={
          <>
            <span className="[form:has(#type-website:checked)_&]:hidden">
              The address of an RSS or Atom feed, such as https://example.com/feed.xml. Watchdog fetches it once
              to check it before saving.
            </span>
            <span className="hidden [form:has(#type-website:checked)_&]:inline">
              The page to watch, such as https://example.com/pricing.
            </span>
          </>
        }
        inputMode="url"
        autoComplete="url"
        defaultValue={values.url}
      />
      <fieldset
        className={cn("hidden flex-col gap-2", shownFor.website)}
        aria-describedby={error?.field === "render" ? "render-error" : "render-help"}
      >
        <legend className={cn(label, "mb-2")}>How to read the page</legend>
        <div className="flex flex-wrap gap-1">
          {renders.map((render) => (
            <label key={render.value} className={choice}>
              <input
                type="radio"
                id={`render-${render.value}`}
                name="render"
                value={render.value}
                // A page sent back with a browser this install doesn't run comes back as Static, the
                // choice that can be sent.
                defaultChecked={(offered(values.render) ? values.render : "static") === render.value}
                disabled={!offered(render.value)}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- only with an error on this field to fix
                autoFocus={error?.field === "render" && render.value === "static"}
                className="sr-only"
              />
              {render.title}
            </label>
          ))}
        </div>
        {error?.field === "render" ? (
          <p id="render-error" role="alert" className={fieldError}>
            {error.message}
          </p>
        ) : (
          <p id="render-help" className="text-xs text-muted-foreground">
            Static reads the page&apos;s HTML as served, in one quick fetch. Rendered runs the page&apos;s scripts
            first, for a page that builds its content with them, and takes longer. Rendered in Chromium is a
            slower fallback for a page that Rendered gets wrong.
            {offered("obscura") ? null : " Rendered is unavailable: this install doesn't run Obscura."}
            {offered("chromium") ? null : " Rendered in Chromium is unavailable: this install doesn't run Chromium."}
          </p>
        )}
      </fieldset>
      <TextField
        id="region"
        label="Region"
        optional
        className={shownFor.website}
        error={errorFor("region")}
        help="A CSS selector for the part of the page to watch, such as #pricing .plan. When it matches several elements, Watchdog watches them all. Leave it empty to watch the whole page."
        autoCapitalize="off"
        autoComplete="off"
        placeholder="main"
        maxLength={maxRegionLength}
        defaultValue={values.region}
        inputClassName={dataBox}
      />
      <div className={cn("hidden flex-col gap-2", shownFor.website)}>
        <label htmlFor="ignore" className={label}>
          Ignored text <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <textarea
          id="ignore"
          name="ignore"
          rows={3}
          // The text goes back in the URL with a problem, so it stays well under a URL's limits.
          maxLength={2000}
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
            <span className="font-medium text-foreground">
              The risk is yours: the site may object or block this server&apos;s address.
            </span>{" "}
            Watchdog then fetches the page even where the site&apos;s robots.txt asks crawlers not to.
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
      <fieldset className={cn("hidden flex-col gap-4", shownFor.webhook)}>
        <legend className={cn(label, "mb-2")}>
          Mapping <span className="font-normal text-muted-foreground">(optional)</span>
        </legend>
        <p className="text-xs text-muted-foreground">
          JSONPaths that pick the Item&apos;s fields out of each request&apos;s JSON. Each takes the first value its
          path finds. The whole JSON is kept on the Item either way, for Rules to read.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {mappings.map((mapping) => (
            <TextField
              key={mapping.id}
              id={mapping.id}
              label={mapping.label}
              className="flex"
              error={errorFor(mapping.id)}
              help={mapping.help}
              autoCapitalize="off"
              autoComplete="off"
              placeholder={mapping.placeholder}
              maxLength={1000}
              defaultValue={values[mapping.id]}
              inputClassName={dataBox}
            />
          ))}
        </div>
      </fieldset>
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
            placeholder="Taken from what it watches"
            defaultValue={values.name}
            className={field}
          />
        </div>
        <div className={cn("flex-col gap-2", shownFor.schedule)}>
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

/**
 * A labelled text field, hidden unless `className` shows it, with its help or its error below. With
 * `websiteLabel`, a second label takes over while Website is chosen. Each is its own <label>, so
 * each one's text is exactly its name, not both run together.
 */
function TextField({
  id,
  label: text,
  websiteLabel,
  optional = false,
  help,
  error,
  className,
  inputClassName,
  ...input
}: {
  id: FieldName;
  label: string;
  websiteLabel?: string;
  optional?: boolean;
  help: ReactNode;
  error: string | undefined;
  className: string;
  inputClassName?: string;
} & Omit<ComponentProps<"input">, "id" | "name" | "className">) {
  const invalid = error !== undefined;
  return (
    <div className={cn("hidden flex-col gap-2", className)}>
      <label
        htmlFor={id}
        className={cn(label, websiteLabel !== undefined && "[form:has(#type-website:checked)_&]:hidden")}
      >
        {text}
        {optional ? <span className="font-normal text-muted-foreground"> (optional)</span> : null}
      </label>
      {websiteLabel === undefined ? null : (
        <label htmlFor={id} className={cn(label, "hidden [form:has(#type-website:checked)_&]:block")}>
          {websiteLabel}
        </label>
      )}
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
