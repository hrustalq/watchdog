import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Timestamp } from "@/components/timestamp";
import { Button } from "@/components/ui/button";
import { itemWithLog, manualRunIn } from "@/lib/feed";
import { listRules } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import { kindLabel, modelLink } from "../../rules/words";
import { Notice } from "../../sign-in/notice";
import { SubmitButton } from "../../sign-in/submit-button";
import { runExtractorRuleAction } from "./actions";

export const metadata: Metadata = { title: "Item · Watchdog" };

export default function ItemPage({ params, searchParams }: PageProps<"/items/[id]">) {
  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link
          href="/"
          className="rounded-sm text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          Feed
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span aria-current="page">Item</span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-col px-4 py-8">
        <Suspense fallback={<div aria-busy="true" className="h-48 rounded-lg bg-muted" />}>
          <ItemDetail params={params} searchParams={searchParams} />
        </Suspense>
      </main>
    </div>
  );
}

async function ItemDetail({ params, searchParams }: PageProps<"/items/[id]">) {
  const [{ workspace }, { id }, { run: runId }] = await Promise.all([requireWorkspace(), params, searchParams]);
  const { db } = server();
  // Another Workspace's Item is missing too, so its id says nothing about whether it exists.
  const [found = notFound(), { extractorRules, hasModel }] = await Promise.all([
    itemWithLog(db, workspace.id, id),
    listRules(db, workspace.id),
  ]);
  const run = manualRunIn(found.log, runId);

  const envelope = [
    { term: "Source", detail: found.source.name },
    { term: "Author", detail: found.author ?? <Missing>None given</Missing> },
    {
      term: "Published",
      detail: found.publishedAt === null ? <Missing>No date given</Missing> : <Timestamp at={found.publishedAt} />,
    },
    { term: "Captured", detail: <Timestamp at={found.capturedAt} /> },
    {
      term: "Language",
      detail: found.language === null ? <Missing>Not detected</Missing> : <span className="font-mono">{found.language}</span>,
    },
    { term: "Backfill", detail: found.isBackfill ? "Yes, from the Source's first fetch" : "No" },
  ];

  return (
    <article className="flex flex-col gap-8">
      <header className="flex flex-col gap-3">
        <h1 className="text-headline break-words">{found.title ?? "Untitled Item"}</h1>
        {found.url === null ? null : (
          <a
            href={found.url}
            rel="noreferrer"
            className="self-start rounded-sm font-mono text-[0.8125rem] break-all text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            {found.url}
          </a>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          {envelope.map(({ term, detail }) => (
            <div key={term} className="contents">
              <dt className="text-xs leading-5 font-medium tracking-[0.01em] text-muted-foreground">{term}</dt>
              <dd className="min-w-0 break-words">{detail}</dd>
            </div>
          ))}
        </dl>
      </header>
      {found.body === "" ? (
        <p className="text-sm text-muted-foreground">The Source gave no text for this Item.</p>
      ) : (
        <p className="max-w-[70ch] text-base leading-[1.6] break-words whitespace-pre-line">
          {found.body}
        </p>
      )}
      <section aria-labelledby="fields" className="flex flex-col gap-3">
        <h2 id="fields" className="text-title">
          Extracted fields
        </h2>
        {found.fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No fields on this Item yet.</p>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 font-mono text-[0.8125rem]">
            {found.fields.map(({ name, value }) => (
              <div key={name} className="contents">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="min-w-0 break-words">{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <section aria-labelledby="run-rule" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="run-rule" className="text-title">
            Run an Extractor Rule
          </h2>
          <p className="text-sm text-muted-foreground">
            Runs on this Item even if it doesn&apos;t meet the rule&apos;s Condition, and replaces what that rule found
            before. An Agent-backed rule makes one call to your model, which your provider bills as usual.
          </p>
        </div>
        {/* A new key for each run, so the notice takes focus again after a second run. */}
        {run === undefined ? null : <RunOutcome key={run.id} {...run} />}
        {extractorRules.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No Extractor Rules yet.{" "}
            <Link href="/rules" className={inlineLink}>
              Add one
            </Link>
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {extractorRules.map((rule) => (
              <RunRule key={rule.id} itemId={found.id} rule={rule} needsModel={rule.kind === "agent" && !hasModel} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="log" className="flex flex-col gap-3">
        <h2 id="log" className="text-title">
          Log
        </h2>
        <ol className="divide-y rounded-lg border bg-muted font-mono text-[0.8125rem]">
          {found.log.map((row) => (
            <li key={row.id} className="flex flex-col gap-x-4 px-3 py-2 sm:flex-row">
              <Timestamp at={row.at} seconds className="shrink-0 text-muted-foreground" />
              <span className="shrink-0 sm:w-16">{row.stage}</span>
              <span className="min-w-0 break-words">{row.message}</span>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

const inlineLink =
  "rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30";

function RunOutcome({ message, failed }: { message: string; failed: boolean }) {
  return failed ? (
    <Notice role="alert" className="flex items-start gap-2 text-sm text-alarm">
      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm" />
      <span className="min-w-0 break-words">{message}</span>
    </Notice>
  ) : (
    <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm break-words">
      {message}
    </Notice>
  );
}

function RunRule({
  itemId,
  rule,
  needsModel,
}: {
  itemId: string;
  rule: { id: string; name: string; kind: keyof typeof kindLabel; enabled: boolean };
  needsModel: boolean;
}) {
  const label = (
    <>
      Run<span className="sr-only"> {rule.name}</span>
    </>
  );
  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium break-words">{rule.name}</p>
        <p className="text-xs font-medium tracking-[0.01em] text-muted-foreground">
          {kindLabel[rule.kind]}
          {rule.enabled ? null : " · Disabled for new Items"}
        </p>
        {needsModel ? (
          <p className="text-sm text-muted-foreground">
            Disabled until this Workspace has a model.{" "}
            <Link href={modelLink} className={inlineLink}>
              Set up a model
            </Link>
          </p>
        ) : null}
      </div>
      {needsModel ? (
        <Button variant="outline" disabled className="w-full sm:w-auto">
          {label}
        </Button>
      ) : (
        <form action={runExtractorRuleAction.bind(null, itemId, rule.id)}>
          <SubmitButton variant="outline" pendingLabel="Running…" className="sm:w-auto">
            {label}
          </SubmitButton>
        </form>
      )}
    </li>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
