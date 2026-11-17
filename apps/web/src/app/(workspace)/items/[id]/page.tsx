import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { localDateTime } from "@watchdog/core";
import { filledLamp, Rating } from "@/components/rating";
import { Timestamp } from "@/components/timestamp";
import { PageBar } from "@/components/page-bar";
import { Page } from "@/components/page";
import { PanelList } from "@/components/panel-list";
import { Section } from "@/components/section";
import { Button } from "@/components/ui/button";
import { deliveryStatus, isCallFailure, isFailureRow, itemActions, itemWithLog, manualRunIn } from "@/lib/feed";
import { knownCategories, listRules } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import { RatingControls } from "../../correct-rating";
import { Refresher } from "../../refresher";
import { kindLabel, modelLink } from "../../rules/words";
import { SubmitButton } from "@/components/submit-button";
import { runExtractorRuleAction } from "./actions";
import { CorrectCategories } from "./correct-categories";
import { RunOutcome } from "./run-outcome";
import { RunStatus } from "./run-status";

// Only an Item that's here reaches this page: a missing one renders app/not-found.tsx under the
// layout's own title.
export const metadata: Metadata = { title: "Item · Watchdog" };

// The data is read without Suspense, so the Item is in the first HTML, which is how it and its
// Correction forms work without JavaScript.
export const instant = false;

export default function ItemPage({ params, searchParams }: PageProps<"/items/[id]">) {
  return (
    <div className="flex flex-1 flex-col">
      <PageBar trail={[{ href: "/", label: "Feed" }, { label: "Item" }]} />
      <Page gap="none">
        <ItemDetail params={params} searchParams={searchParams} />
      </Page>
    </div>
  );
}

async function ItemDetail({ params, searchParams }: PageProps<"/items/[id]">) {
  const [{ workspace }, { id }, { run: runId }] = await Promise.all([requireWorkspace(), params, searchParams]);
  const { db } = server();
  // Another Workspace's Item is missing too, so its id says nothing about whether it exists.
  const [found = notFound(), { extractorRules, hasModel }, fired, suggestions] = await Promise.all([
    itemWithLog(db, workspace.id, id),
    listRules(db, workspace.id),
    itemActions(db, workspace.id, id),
    // The Categories the add box offers, which are the Workspace's, so it is read with the Item.
    knownCategories(db, workspace.id),
  ]);
  const run = manualRunIn(found.log, runId);

  const envelope = [
    {
      term: "Rating",
      detail: (
        // A container, so the Correction scale's meaning can drop its indent when the label and the
        // level buttons can't share a line (correct-rating.tsx, `Scale`).
        <div id="rating" className="@container flex scroll-mt-4 flex-col items-start gap-2">
          <span className="flex max-w-full flex-wrap items-center gap-x-2 gap-y-1">
            <Rating severity={found.severity} importance={found.importance} />
            <a href="#log" className={inlineLink}>
              See the Log
            </a>
          </span>
          <RatingControls
            itemId={found.id}
            severity={found.severity}
            importance={found.importance}
            originalRating={found.originalRating}
          />
        </div>
      ),
    },
    {
      term: "Categories",
      detail: (
        <CorrectCategories
          itemId={found.id}
          categories={found.categories.map(({ category }) => category)}
          suggestions={suggestions}
        />
      ),
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
      {/* While the pipeline still has the Item, what it adds — a Rating, a summary, Categories, a
          field, a Log row — arrives without a reload. A refresh keeps the scroll position, the focus
          and an open run's notice, and waits while a form is saving. Once `processed_at` is set there
          is nothing left to wait for, so the page stops asking. */}
      {found.processedAt === null ? <Refresher watchFor={waitingFor} /> : null}
      <header className="flex flex-col gap-3 @container">
        <h1 className="text-headline break-words">{found.title ?? "Untitled Item"}</h1>
        {found.url === null ? null : (
          <a
            href={found.url}
            rel="noreferrer"
            className="self-start rounded-sm text-data break-all text-muted-foreground underline underline-offset-4 outline-hidden hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/60"
          >
            {found.url}
          </a>
        )}
        {/* One column when the text is enlarged past what the term/detail pair can hold: 16rem is
            measured in the current root size, so 200% text stacks the envelope while the normal
            320px and 390px layouts keep their two columns. */}
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm @max-[16rem]:grid-cols-1">
          {envelope.map(({ term, detail }) => (
            <div key={term} className="contents">
              <dt className="text-xs leading-5 font-medium tracking-[0.01em] text-muted-foreground">{term}</dt>
              <dd className="min-w-0 break-words">{detail}</dd>
            </div>
          ))}
        </dl>
      </header>
      {found.summary === null ? null : (
        <Section id="summary" title="Summary">
          <p className={readingText}>{found.summary}</p>
        </Section>
      )}
      <Section id="original" title="Original text">
        {found.body === "" ? (
          <p className="text-sm text-muted-foreground">The Source gave no text for this Item.</p>
        ) : (
          <p className={readingText}>{found.body}</p>
        )}
      </Section>
      <Section id="fields" title="Extracted fields">
        {found.fields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No fields on this Item yet.</p>
        ) : (
          // A field's name can be 64 characters with nowhere to wrap, so a phone stacks it on its value.
          <dl className="grid gap-x-6 gap-y-1 text-data sm:grid-cols-[minmax(0,14rem)_1fr]">
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
      </Section>
      <ActionsSection
        fired={fired}
        processed={found.processedAt !== null}
        isBackfill={found.isBackfill}
        actedOn={found.log.some(({ stage, data }) => stage === "act" && aboutAnAction(data))}
        timezone={workspace.timezone}
      />
      <Section
        id="run-rule"
        title="Run an Extractor Rule"
        description="Runs on this Item even if it doesn't meet the rule's Condition, and replaces what that rule found before. An Agent-backed rule makes one call to your model, which your provider bills as usual."
      >
        {/* A new key for each run, so the notice takes focus again after a second run. It sits outside
            the list's disclosure: after a run its notice has to be visible without opening anything. */}
        {run === undefined ? null : <RunOutcome key={run.id} run={run} />}
        <RuleList itemId={found.id} rules={extractorRules} hasModel={hasModel} />
      </Section>
      <Section id="log" title="Log" titleClassName="scroll-mt-4">
        <PanelList as="ol" className="bg-muted text-data">
          {found.log.map((row) => (
            <li key={row.id} className="flex flex-col gap-x-4 px-3 py-2 sm:flex-row">
              <Timestamp at={row.at} seconds className="shrink-0 text-muted-foreground" />
              <span className="shrink-0 sm:w-16">{row.stage}</span>
              <LogMessage row={row} />
            </li>
          ))}
        </PanelList>
      </Section>
    </article>
  );
}

const inlineLink =
  "rounded-sm text-foreground underline underline-offset-4 outline-hidden focus-visible:ring-3 focus-visible:ring-ring/60";

/**
 * How many Extractor Rules Item detail lists inline. A row is about 103px tall on a phone, so three
 * keep the Log within a screen of the Extracted fields; a Workspace with more gets a disclosure,
 * because the Log is what most visits come for and running a rule by hand is occasional.
 */
const inlineRulesUpTo = 3;

/** A rule list's disclosure, at the 32px of a control, like the delete confirmation on the Rules screen. */
const disclosure =
  "flex h-8 cursor-pointer list-none items-center rounded-lg px-3 text-sm font-medium select-none outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 group-open:rounded-b-none group-open:border-b group-open:bg-muted dark:hover:bg-muted/50 [&::-webkit-details-marker]:hidden";

/**
 * One Log row's words. A failure carries a lamp of its own and says so in the accessibility tree, so it
 * reads as a failure without colour, and a failed model call links to the screen that can fix it. A
 * model's own message can run over several lines, and one holding HTML stays text.
 */
function LogMessage({ row }: { row: { stage: string; data: unknown; message: string } }) {
  if (!isFailureRow(row)) {
    return <span className="min-w-0 break-words whitespace-pre-line">{row.message}</span>;
  }
  return (
    <span className="flex min-w-0 items-start gap-2 text-alarm">
      <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm ${filledLamp}`} />
      <span className="min-w-0 break-words whitespace-pre-line">
        <span className="sr-only">Failure: </span>
        {row.message}
        {isCallFailure(row) ? (
          <>
            {" "}
            <Link href={modelLink} className={inlineLink}>
              Check the model
            </Link>
          </>
        ) : null}
      </span>
    </span>
  );
}

/**
 * How long Item detail waits on the pipeline. A job that is still alive expires after ten minutes, and
 * the queue retries it three times with backoff, so half an hour covers a slow one. An Item that stays
 * unprocessed for good — captured before `processed_at` existed, or whose worker died on its last
 * attempt — has nothing more coming, so the page stops asking instead of polling forever.
 */
const waitingFor = 30 * 60_000;

const readingText = "max-w-[70ch] text-base leading-[1.6] break-words whitespace-pre-line";

/**
 * The Workspace's Extractor Rules: a sentence when there are none, the rows inline while they're few,
 * and a disclosure past that. The rows are the same either way, so only the panel around them changes.
 */
function RuleList({
  itemId,
  rules,
  hasModel,
}: {
  itemId: string;
  rules: Awaited<ReturnType<typeof listRules>>["extractorRules"];
  hasModel: boolean;
}) {
  if (rules.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No Extractor Rules yet.{" "}
        <Link href="/rules" className={inlineLink}>
          Add one
        </Link>
      </p>
    );
  }
  const rows = rules.map((rule) => (
    <RunRule key={rule.id} itemId={itemId} rule={rule} needsModel={rule.kind === "agent" && !hasModel} />
  ));
  if (rules.length <= inlineRulesUpTo) return <PanelList>{rows}</PanelList>;
  return (
    <details className="group rounded-lg border">
      <summary className={disclosure}>
        <span className="group-open:hidden">
          Show <span className="tabular-nums">{rules.length}</span> Extractor Rules
        </span>
        <span className="hidden group-open:inline">
          Hide <span className="tabular-nums">{rules.length}</span> Extractor Rules
        </span>
      </summary>
      <ul className="divide-y">{rows}</ul>
    </details>
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
            className="rounded-sm underline-offset-4 outline-hidden hover:underline focus-visible:ring-3 focus-visible:ring-ring/60"
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
    <Section id="actions" title="Actions">
      {fired.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <PanelList>
          {fired.map((row) => (
            <li key={row.id} className="flex flex-col gap-1 p-3">
              <p className="text-sm font-medium break-words">
                <Link
                  href={`/rules/action/${row.id}`}
                  className="rounded-sm underline-offset-4 outline-hidden hover:underline focus-visible:ring-3 focus-visible:ring-ring/60"
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
                  <li
                    key={`${sent.destination} ${sent.at.toISOString()}`}
                    className={`flex items-start gap-2 ${sent.failed ? "text-alarm" : ""}`}
                  >
                    <span
                      aria-hidden="true"
                      className={`mt-1.5 size-1.5 shrink-0 rounded-full ${lampFor(sent.failed ? "failed" : "sent", sent.failed)}`}
                    />
                    <span className="min-w-0 break-words">
                      {sent.failed ? (
                        <Link href="/destinations" className={inlineLink}>
                          {sent.destination}
                        </Link>
                      ) : (
                        sent.destination
                      )}
                      <span className={sent.failed ? "" : "text-muted-foreground"}>
                        {sent.failed
                          ? ` · Not sent in the Digest: ${(sent.reason ?? "no reason was recorded").replace(/\.$/, "")}. No more retries`
                          : " · Sent in the Digest at "}
                        {sent.failed ? null : <Timestamp at={sent.at} />}
                      </span>
                    </span>
                  </li>
                ))}
                {row.digestTo.map(({ destination: to, heldUntil }) => (
                  <li key={to} className="flex items-start gap-2">
                    <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full ${lampFor(heldUntil === null ? "queued" : "held", false)}`} />
                    <span className="min-w-0 break-words">
                      {to}
                      <span className="text-muted-foreground">
                        {/* A Destination the hosted email cap holds goes at the end of the local day, and
                            the rest of the Digest went at its time. */}
                        {heldUntil === null
                          ? " · In the next Digest"
                          : ` · Held until ${localDateTime(heldUntil, timezone)}: the hosted limit of 50 mails a day`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </PanelList>
      )}
    </Section>
  );
}

function Missing({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}
