import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { releasesFeedUrl, signInToken } from "@watchdog/core";
import { Timestamp } from "@/components/timestamp";
import { requireWorkspace, server } from "@/lib/server";
import {
  addProblems,
  addValues,
  listSources,
  problemField,
  problemMessage,
  schedules,
  watchedSourceName,
} from "@/lib/sources";
import { SubmitButton } from "../sign-in/submit-button";
import { removeSourceAction } from "./actions";
import { AddSourceForm } from "./add-source-form";

export const metadata: Metadata = { title: "Sources · Watchdog" };

export default function SourcesPage({ searchParams }: PageProps<"/sources">) {
  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link
          href="/"
          className="rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          Workspace
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span aria-current="page">Sources</span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
        <h1 className="text-headline">Sources</h1>
        <section aria-labelledby="add-source" className="flex flex-col gap-4 rounded-lg border p-4">
          <h2 id="add-source" className="text-title">
            Add a Source
          </h2>
          {/* The form is in the static shell, so it submits without JavaScript. What the last submit
              said, read from the URL, streams in over it, which takes JavaScript to show. */}
          <Suspense fallback={<AddSourceForm />}>
            <AddSourceFormWithOutcome searchParams={searchParams} />
          </Suspense>
        </section>
        <Suspense fallback={<div aria-busy="true" className="h-32 rounded-lg bg-muted" />}>
          <SourceList />
        </Suspense>
      </main>
    </div>
  );
}

async function AddSourceFormWithOutcome({ searchParams }: Pick<PageProps<"/sources">, "searchParams">) {
  const params = await searchParams;
  const param = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  const values = addValues(param);
  const { db, mode } = server();
  const { workspace } = await requireWorkspace();
  // The token field says whether it's needed, which depends on a GitHub sign-in.
  const githubSignIn = (await signInToken(db, workspace.id)) !== undefined;
  if (param("added") !== "") {
    return <AddSourceForm added githubSignIn={githubSignIn} values={{ ...addValues(() => ""), type: values.type }} />;
  }
  // The code comes from the URL, so only a known one counts.
  const problem = addProblems.find((known) => known === param("error"));
  if (problem === undefined) return <AddSourceForm githubSignIn={githubSignIn} />;
  // Only the code travels in the URL, so the Source it's already watched as is looked up.
  const watching = problem === "duplicate" ? await watchedSourceName(db, workspace.id, values) : undefined;
  const shown = { ...values, status: param("status"), mode, source: watching };
  return (
    <AddSourceForm
      values={values}
      githubSignIn={githubSignIn}
      tokenDropped={param("pasted") !== ""}
      error={{ field: problemField(problem, values.type), message: problemMessage(problem, shown) }}
    />
  );
}

async function SourceList() {
  const { workspace } = await requireWorkspace();
  const sources = await listSources(server().db, workspace.id);
  const scheduleLabel = (cron: string | null) => schedules.find((preset) => preset.cron === cron)?.label;
  // RSS and website Sources watch a URL, a GitHub Source a repo's releases or issues, or a search.
  const urlOf = ({ config }: (typeof sources)[number]) => {
    if ("url" in config) return config.url;
    if (!("kind" in config)) return null;
    if (config.kind === "mentions") {
      // The same search on github.com, which the user can open to check it.
      const q = `(${config.term}) (is:issue OR is:pr)${config.within === undefined ? "" : ` ${config.within}`}`;
      return `https://github.com/search?${new URLSearchParams({ q, type: "issues" }).toString()}`;
    }
    return `https://github.com/${config.repo}/${config.kind}`;
  };
  // The URL is on the line above, so the error needn't repeat the URL it fetched.
  const withoutUrl = ({ config }: (typeof sources)[number], error: string) => {
    if ("url" in config) return error.replace(config.url, "the feed");
    return "kind" in config && config.kind === "releases" ? error.replace(releasesFeedUrl(config.repo), "the releases feed") : error;
  };

  return (
    <section aria-labelledby="watched" className="flex flex-col gap-3">
        <h2 id="watched" className="text-title">
          Watching <span className="tabular-nums">{sources.length}</span>{" "}
          {sources.length === 1 ? "Source" : "Sources"}
        </h2>
        {sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None yet. Add a feed, a GitHub repo or a GitHub search above, and every Item it captures shows up
            in the Feed.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {sources.map((row) => (
              <li key={row.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-title break-words">{row.name}</h3>
                  <p className="font-mono text-[0.8125rem] break-all text-muted-foreground">{urlOf(row)}</p>
                  <p className="text-sm text-muted-foreground">
                    {scheduleLabel(row.schedule) ?? <span className="font-mono">{row.schedule}</span>}
                    {" · "}
                    {row.lastPolledAt === null ? (
                      // A poll that failed doesn't set lastPolledAt.
                      `${row.lastError === null ? "Not polled" : "No successful poll"} yet`
                    ) : (
                      <>
                        Last polled <Timestamp at={row.lastPolledAt} />
                      </>
                    )}
                  </p>
                  {row.lastError === null ? null : (
                    <p className="flex items-start gap-2 text-sm text-alarm">
                      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm" />
                      <span className="min-w-0 break-words">
                        Last poll failed
                        {row.lastErrorAt === null ? null : (
                          <>
                            {" "}
                            at <Timestamp at={row.lastErrorAt} />
                          </>
                        )}
                        : {withoutUrl(row, row.lastError)}
                      </span>
                    </p>
                  )}
                </div>
                <RemoveSource id={row.id} name={row.name} />
              </li>
            ))}
          </ul>
        )}
      </section>
  );
}

/**
 * Remove, then a confirmation in the page that says what goes with it. A disclosure works without
 * JavaScript, unlike a confirm() dialog.
 */
function RemoveSource({ id, name }: { id: string; name: string }) {
  return (
    <details className="group shrink-0 sm:max-w-64">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg px-3 text-sm font-medium outline-none select-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 group-open:bg-muted dark:hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Remove</span>
        <span className="hidden group-open:inline">Keep it</span>
      </summary>
      <div className="mt-2 flex flex-col gap-3 rounded-lg bg-muted p-3">
        <p className="text-sm">
          Removing {name} also deletes every Item it captured, and their Logs, from the Feed. This
          can&apos;t be undone.
        </p>
        <form action={removeSourceAction.bind(null, id)}>
          <SubmitButton variant="destructive" pendingLabel="Removing…">
            Remove Source and its Items
          </SubmitButton>
        </form>
      </div>
    </details>
  );
}
