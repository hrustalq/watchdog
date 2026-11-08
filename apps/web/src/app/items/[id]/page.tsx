import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Rating } from "@/components/rating";
import { Timestamp } from "@/components/timestamp";
import { Button } from "@/components/ui/button";
import { deliveryStatus, isActFailure, itemActions, itemWithLog, manualRunIn } from "@/lib/feed";
import { listRules } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import { RatingControls } from "../../correct-rating";
import { kindLabel, modelLink } from "../../rules/words";
import { Notice } from "../../sign-in/notice";
import { SubmitButton } from "../../sign-in/submit-button";
import { runExtractorRuleAction } from "./actions";
import { CorrectCategories } from "./correct-categories";
import { RunStatus } from "./run-status";

export const metadata: Metadata = { title: "Item · Watchdog" };

// The data is read without Suspense, so the Item is in the first HTML, which is how it and its
// Correction forms work without JavaScript.
export const instant = false;

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
        <ItemDetail params={params} searchParams={searchParams} />
      </main>
    </div>
  );
}

async function ItemDetail({ params, searchParams }: PageProps<"/items/[id]">) {
  const [{ workspace }, { id }, { run: runId }] = await Promise.all([requireWorkspace(), params, searchParams]);
  const { db } = server();
  // Another Workspace's Item is missing too, so its id says nothing about whether it exists.
  const [found = notFound(), { extractorRules, hasModel }, fired] = await Promise.all([
    itemWithLog(db, workspace.id, id),
    listRules(db, workspace.id),
    itemActions(db, workspace.id, id),
  ]);
  const run = manualRunIn(found.log, runId);

  const envelope = [
    {
      term: "Rating",
      detail: (
        <div id="rating" className="flex scroll-mt-4 flex-col items-start gap-2">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Rating severity={found.severity} importance={found.importance} />
            <a href="#log" className={inlineLink}>
              See the Log
            </a>
          </span>
          <RatingControls itemId={found.id} severity={found.severity} importance={found.importance} />
        </div>
      ),
    },
    {
      term: "Categories",
      detail: <CorrectCategories itemId={found.id} categories={found.categories.map(({ category }) => category)} />,
    },
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
      {found.summary === null ? null : (
        <section aria-labelledby="summary" className="flex flex-col gap-3">
          <h2 id="summary" className="text-title">
            Summary
          </h2>
          <p className={readingText}>{found.summary}</p>
        </section>
      )}
      <section aria-labelledby="original" className="flex flex-col gap-3">
        <h2 id="original" className="text-title">
          Original text
        </h2>
        {found.body === "" ? (
          <p className="text-sm text-muted-foreground">The Source gave no text for this Item.</p>
        ) : (
          <p className={readingText}>{found.body}</p>
        )}
      </section>
      <section aria-labelledby="fields" className="flex flex-col gap-3">
        <h2 id="fields" className="text-title">
          Extracted fields
        </h2>
        {found.fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No fields on this Item yet.</p>
        ) : (
          // A field's name can be 64 characters with nowhere to wrap, so a phone stacks it on its value.
          <dl className="grid gap-x-6 gap-y-1 font-mono text-[0.8125rem] sm:grid-cols-[minmax(0,14rem)_1fr]">
            {found.fields.map(({ name, value, extractorRule }) => (
              <div key={name} className="contents">
                <dt className="break-all text-muted-foreground">{name}</dt>
                <dd className="mb-1 min-w-0 break-words sm:mb-0">
                  {Array.isArray(value) ? value.join(", ") : String(value)}
                  {extractorRule === null ? null : (
                    <span className="ml-2 font-sans text-xs text-muted-foreground">from {extractorRule.name}</span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
      <ActionsSection
        fired={fired}
        processed={found.processedAt !== null}
        isBackfill={found.isBackfill}
        actedOn={found.log.some(({ stage, data }) => stage === "act" && aboutAnAction(data))}
        timezone={workspace.timezone}
      />
      <section aria-labelledby="run-rule" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="run-rule" className="text-title">
            Run an Extractor Rule
          </h2>
          <p className="max-w-[70ch] text-sm text-muted-foreground">
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
        <h2 id="log" className="scroll-mt-4 text-title">
          Log
        </h2>
        <ol className="divide-y rounded-lg border bg-muted font-mono text-[0.8125rem]">
          {found.log.map((row) => (
            <li key={row.id} className="flex flex-col gap-x-4 px-3 py-2 sm:flex-row">
              <Timestamp at={row.at} seconds className="shrink-0 text-muted-foreground" />
              <span className="shrink-0 sm:w-16">{row.stage}</span>
              {/* A model's validation failure runs over several lines. */}
              {isActFailure(row) ? (
                <span className="flex min-w-0 items-start gap-2 text-alarm">
                  <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm ${filledLamp}`} />
                  <span className="min-w-0 break-words whitespace-pre-line">
                    <span className="sr-only">Failure: </span>
                    {row.message}
                  </span>
                </span>
              ) : (
                <span className="min-w-0 break-words whitespace-pre-line">{row.message}</span>
              )}
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

const inlineLink =
  "rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30";

const readingText = "max-w-[70ch] text-base leading-[1.6] break-words whitespace-pre-line";

function RunOutcome({ message, failed }: { message: string; failed: boolean }) {
  return failed ? (
    <Notice role="alert" className="flex items-start gap-2 text-sm text-alarm">
      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm" />
      <span className="min-w-0 break-words">
        {message}
        {/* The reason is someone else's sentence, and may not end in a full stop. */}
        <span className="block text-muted-foreground">What this rule found before stays as it was.</span>
      </span>
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
        <p className="text-sm font-medium break-words">
          <Link
            href={`/rules/extractor/${rule.id}`}
            className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            {rule.name}
          </Link>
        </p>
        <p className="text-xs font-medium tracking-[0.01em] text-muted-foreground">
          {kindLabel[rule.kind]}
          {rule.kind === "agent" && !needsModel ? " · One model call" : null}
          {rule.enabled ? null : " · Off for new Items"}
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
          <RunStatus name={rule.name} />
        </form>
      )}
    </li>
  );
}

// Forced colours drop backgrounds, which would hide a filled lamp.
const filledLamp = "forced-color-adjust-none forced-colors:bg-[CanvasText]";

/** Red for a failure and green for a send, filled. Anything still waiting gets a hollow lamp. */
function lampFor(status: string, failed: boolean) {
  if (failed) return `bg-alarm ${filledLamp}`;
  return status === "sent" ? `bg-ok ${filledLamp}` : "border border-muted-foreground";
}

/** Whether an `act` Log row names an Action: one that fired, couldn't fire, was skipped, or sent. */
const aboutAnAction = (data: unknown) => typeof data === "object" && data !== null && "actionId" in data;

/**
 * What each Action that fired on this Item did, from its Deliveries. Nothing in a row is a receiver's
 * answer or a credential: a Delivery's error is Watchdog's own sentence about it.
 */
function ActionsSection({
  fired,
  processed,
  isBackfill,
  actedOn,
  timezone,
}: {
  fired: Awaited<ReturnType<typeof itemActions>>;
  processed: boolean;
  isBackfill: boolean;
  actedOn: boolean;
  timezone: string;
}) {
  let empty = "No Action matched.";
  if (!processed) empty = "Actions haven't been evaluated yet. They run once the pipeline finishes with this Item.";
  else if (isBackfill) empty = "No Action fires on an Item from a Backfill.";
  else if (actedOn) empty = "Nothing is waiting to go or was sent from this Item. The Log says why.";
  return (
    <section aria-labelledby="actions" className="flex flex-col gap-3">
      <h2 id="actions" className="text-title">
        Actions
      </h2>
      {fired.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {fired.map((row) => (
            <li key={row.id} className="flex flex-col gap-1 p-3">
              <p className="text-sm font-medium break-words">
                <Link
                  href={`/rules/action/${row.id}`}
                  className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
                >
                  {row.name}
                </Link>
              </p>
              <ul className="flex flex-col gap-1 text-sm">
                {row.deliveries.map((sent) => {
                  const { text, failed } = deliveryStatus(sent, timezone);
                  return (
                    <li key={sent.destination} className={`flex items-start gap-2 ${failed ? "text-alarm" : ""}`}>
                      <span
                        aria-hidden="true"
                        className={`mt-1.5 size-1.5 shrink-0 rounded-full ${lampFor(sent.status, failed)}`}
                      />
                      <span className="min-w-0 break-words">
                        {/* A failure links to where the Destination can be tested once it's fixed. */}
                        {failed ? (
                          <Link href="/destinations" className={inlineLink}>
                            {sent.destination}
                          </Link>
                        ) : (
                          <span className="text-foreground">{sent.destination}</span>
                        )}
                        <span className={failed ? "" : "text-muted-foreground"}>
                          {" · "}
                          {text}
                          {sent.status === "sent" && sent.sentAt !== null ? (
                            <>
                              {" at "}
                              <Timestamp at={sent.sentAt} />
                            </>
                          ) : null}
                        </span>
                      </span>
                    </li>
                  );
                })}
                {row.digestSent.map((sent) => (
                  <li key={`${sent.destination} ${sent.at.toISOString()}`} className="flex items-start gap-2">
                    <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full ${lampFor("sent", false)}`} />
                    <span className="min-w-0 break-words">
                      {sent.destination}
                      <span className="text-muted-foreground">
                        {" · Sent in the Digest at "}
                        <Timestamp at={sent.at} />
                      </span>
                    </span>
                  </li>
                ))}
                {row.digestTo.map((name) => (
                  <li key={name} className="flex items-start gap-2">
                    <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full ${lampFor("queued", false)}`} />
                    <span className="min-w-0 break-words">
                      {name}
                      <span className="text-muted-foreground"> · In the next Digest</span>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
