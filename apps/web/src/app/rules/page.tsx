import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { textLink } from "@/components/field-classes";
import { buttonVariants } from "@/components/ui/button";
import { hasUnreadableKey } from "@/lib/model";
import { type ActionKind, digestScheduleName, type RuleKind, ruleNoun, type RuleType } from "@/lib/rule-draft";
import type { RuleSummary } from "@/lib/rule-summary";
import { listRules } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "@/components/notice";
import { Disclosure } from "@/components/disclosure";
import { PageBar } from "@/components/page-bar";
import { Page, PageHeader } from "@/components/page";
import { PanelList, PanelRow } from "@/components/panel-list";
import { Section } from "@/components/section";
import { SignalLine } from "@/components/signal-line";
import { SubmitButton } from "@/components/submit-button";
import { removeRuleAction, setRuleEnabledAction } from "./actions";
import { ForgetDrafts } from "./forget-drafts";
import {
  actionApplies,
  appliesFromNow,
  destinationsLink,
  kindLabel,
  kindsExplained,
  modelLink,
  waitingForConfirmation,
} from "./words";

export const metadata: Metadata = { title: "Rules · Watchdog" };

export default function RulesPage({ searchParams }: PageProps<"/rules">) {
  return (
    <div className="flex flex-1 flex-col">
      <PageBar trail={[{ href: "/", label: "Workspace" }, { label: "Rules" }]} />
      <Page>
        <ForgetDrafts prefix="/rules" />
        <PageHeader title="Rules" description={appliesFromNow} />
        {/* What the last save said is read from the URL, so it streams in. */}
        <Suspense fallback={null}>
          <PageNotice searchParams={searchParams} />
        </Suspense>
        <Section id="add-rule" title="Add a rule" tone="panel" gap={4} description={kindsExplained}>
          <div className="grid gap-4 sm:grid-cols-3">
            <AddRule type="classifier" description="Sorts every Item into Categories." />
            <AddRule
              type="extractor"
              description="Pulls structured fields out of the Items that meet its Condition."
            />
            <AddRule
              type="action"
              description="Sends an alert, calls a webhook or collects a Digest when an Item meets its Condition."
            />
          </div>
        </Section>
        <Suspense fallback={<div aria-busy="true" className="h-48 rounded-lg bg-muted" />}>
          <RuleLists />
        </Suspense>
      </Page>
    </div>
  );
}

async function PageNotice({ searchParams }: Pick<PageProps<"/rules">, "searchParams">) {
  const { saved, refused } = await searchParams;
  // A rule a hosted limit refused isn't saved, and the message names the limit and the usage.
  if (typeof refused === "string") {
    return (
      <Notice role="alert">
        {refused}
      </Notice>
    );
  }
  if (saved === undefined) return null;
  return (
    <Notice role="status">
      Rule saved.
    </Notice>
  );
}

function AddRule({ type, description }: { type: RuleType; description: string }) {
  const newRule = (kind: RuleKind) => (
    <Link
      href={`/rules/new?type=${type}&kind=${kind}`}
      aria-label={`New ${kindLabel[kind]} ${ruleNoun[type]}`}
      className={buttonVariants({ variant: "outline" })}
    >
      {kindLabel[kind]}
    </Link>
  );
  const links =
    type === "action" ? (
      <Link href="/rules/new?type=action" className={buttonVariants({ variant: "outline" })}>
        New Action
      </Link>
    ) : (
      <>
        {newRule("deterministic")}
        {newRule("agent")}
      </>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">{ruleNoun[type]}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="mt-auto flex flex-wrap gap-2">{links}</div>
    </div>
  );
}

async function RuleLists() {
  const { workspace } = await requireWorkspace();
  const { db, encryptionKey } = server();
  const { classifiers, extractorRules, actions, hasModel } = await listRules(db, workspace.id);
  // An Agent-backed rule can't run while the key can't be read, and the switch must still work, so
  // this is its own line rather than part of `needsModel`.
  const unreadableKey = await hasUnreadableKey(db, encryptionKey, workspace.id);
  // What each rule does, so two rules of one kind can be told apart without opening either.
  const summarised = (rules: (RuleRow & { summary: RuleSummary })[]) =>
    rules.map((rule) => ({ ...rule, detail: <SummaryLine summary={rule.summary} /> }));
  return (
    <>
      <RuleList
        type="classifier"
        heading="Classifiers"
        empty="None yet. Items get no Categories until you add one."
        rules={summarised(classifiers)}
        hasModel={hasModel}
        unreadableKey={unreadableKey}
      />
      <RuleList
        type="extractor"
        heading="Extractor Rules"
        empty="None yet. Items get no extracted fields until you add one."
        rules={summarised(extractorRules)}
        hasModel={hasModel}
        unreadableKey={unreadableKey}
      />
      <RuleList
        type="action"
        heading="Actions"
        note={actionApplies}
        empty="None yet. Nothing leaves the Feed until you add one."
        rules={actions.map((action) => ({
          ...action,
          detail: <ActionDetail action={action} />,
          noDestination: action.destinations.length === 0,
        }))}
        hasModel={hasModel}
        unreadableKey={unreadableKey}
      />
    </>
  );
}

interface RuleRow {
  id: string;
  name: string;
  kind: RuleKind | ActionKind;
  enabled: boolean;
  /** What the row says beyond its name and kind. */
  detail?: React.ReactNode;
  /** An Action left with none can't be enabled until it has one. */
  noDestination?: boolean;
}

function RuleList({
  type,
  heading,
  note,
  empty,
  rules,
  hasModel,
  unreadableKey,
}: {
  type: RuleType;
  heading: string;
  note?: string;
  empty: string;
  rules: RuleRow[];
  hasModel: boolean;
  unreadableKey: boolean;
}) {
  return (
    <Section
      id={`${type}-rules`}
      title={
        <>
          {heading} <span className="font-normal text-muted-foreground tabular-nums">{rules.length}</span>
        </>
      }
      description={note}
    >
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <PanelList>
          {rules.map((rule) => (
            <RuleItem
              key={rule.id}
              type={type}
              rule={rule}
              needsModel={rule.kind === "agent" && !hasModel}
              unreadableKey={rule.kind === "agent" && unreadableKey}
            />
          ))}
        </PanelList>
      )}
    </Section>
  );
}

function RuleItem({
  type,
  rule,
  needsModel,
  unreadableKey,
}: {
  type: RuleType;
  rule: RuleRow;
  needsModel: boolean;
  unreadableKey: boolean;
}) {
  return (
    <PanelRow>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-title break-words">
          <Link
            href={`/rules/${type}/${rule.id}`}
            className="inline-flex min-h-6 items-center rounded-sm underline-offset-4 outline-hidden hover:underline focus-visible:ring-3 focus-visible:ring-ring/60"
          >
            {rule.name}
          </Link>
        </h3>
        <p className="text-xs font-medium tracking-[0.01em] text-muted-foreground">{kindLabel[rule.kind]}</p>
        {rule.detail}
        {needsModel ? (
          <p className="text-sm text-muted-foreground">
            Disabled until this Workspace has a model.{" "}
            <Link href={modelLink} className="rounded-sm text-foreground underline underline-offset-4 outline-hidden focus-visible:ring-3 focus-visible:ring-ring/60">
              Set up a model
            </Link>
          </p>
        ) : null}
        {/* The switch still works, as it does today: the rule can be turned off and on again, and
            entering the key is the only other step. */}
        {unreadableKey ? (
          <Warning>
            This rule can&apos;t run until the API key is entered again, because Watchdog can&apos;t read it.{" "}
            <Link href={modelLink} className={textLink}>
              Enter the key again
            </Link>
          </Warning>
        ) : null}
      </div>
      <div className="flex shrink-0 items-start gap-2">
        <EnableSwitch type={type} rule={rule} locked={needsModel || rule.noDestination === true} />
        <DeleteRule type={type} rule={rule} />
      </div>
    </PanelRow>
  );
}

/** What a rule does in one line, or that it now does nothing because its definition no longer parses. */
function SummaryLine({ summary }: { summary: RuleSummary }) {
  if ("unreadable" in summary) {
    return <Warning>Its definition no longer parses, so it doesn&apos;t run. Open it to fix it.</Warning>;
  }
  // Three lines is more than the summary's own limit at phone width, so the cut is the one the
  // summary makes, at a word, and never the browser's mid-word ellipsis. Broken anywhere, so a long
  // unbroken value can't widen the page.
  return <p className="line-clamp-3 text-sm wrap-anywhere">{summary.text}</p>;
}

/** What an Action does in words, where it goes, and where it can't deliver yet. */
function ActionDetail({
  action: { condition, schedule, destinations },
}: {
  action: { condition: string | null; schedule: string | null; destinations: { name: string; confirmed: boolean }[] };
}) {
  const waiting = destinations.filter(({ confirmed }) => !confirmed).map(({ name }) => name);
  return (
    <>
      {condition === null ? (
        <Warning>Its definition no longer parses, so it doesn&apos;t fire. Open it to fix it.</Warning>
      ) : (
        <p className="line-clamp-3 text-sm break-words">{condition}</p>
      )}
      {destinations.length === 0 ? (
        <Warning>No Destination, so it doesn&apos;t fire. Open it to add one.</Warning>
      ) : (
        <p className="text-sm break-words text-muted-foreground">To {destinations.map(({ name }) => name).join(", ")}</p>
      )}
      {schedule === null ? null : (
        <p className="text-sm text-muted-foreground">
          Schedule{" "}
          {digestScheduleName(schedule) ?? <span className="text-data">{schedule}</span>}
        </p>
      )}
      {waiting.length === 0 ? null : (
        <Warning>
          {waitingForConfirmation(waiting)}{" "}
          <Link href={destinationsLink} className={textLink}>
            Go to Destinations
          </Link>
        </Warning>
      )}
    </>
  );
}

/** Why an Action that looks enabled won't deliver: a lamp and full-strength text, unlike the row's other lines. */
function Warning({ children }: { children: React.ReactNode }) {
  return <SignalLine tone="caution">{children}</SignalLine>;
}

/** A form with one button, so it works without JavaScript. The word says what color alone wouldn't. */
function EnableSwitch({ type, rule, locked }: { type: RuleType; rule: RuleRow; locked: boolean }) {
  const on = rule.enabled && !locked;
  return (
    <form action={setRuleEnabledAction.bind(null, type, rule.id, !rule.enabled)}>
      <button
        type="submit"
        role="switch"
        aria-checked={on}
        disabled={locked}
        className="group flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 outline-hidden hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-muted/50"
      >
        <span className="sr-only">{rule.name}: </span>
        <span aria-hidden="true" className="flex h-5 w-9 items-center rounded-md bg-input p-0.5 group-aria-checked:justify-end group-aria-checked:bg-primary">
          <span className="size-4 rounded-sm bg-foreground group-aria-checked:bg-primary-foreground" />
        </span>
        <span className="w-14 text-left text-xs font-medium tracking-[0.01em]">{on ? "Enabled" : "Disabled"}</span>
      </button>
    </form>
  );
}

/** Delete, then a confirmation in the page. A disclosure works without JavaScript, unlike confirm(). */
function DeleteRule({ type, rule }: { type: RuleType; rule: RuleRow }) {
  const consequence =
    type === "action"
      ? "Deleting it stops it firing, and anything it hasn't sent yet never goes out. The Log keeps what it did."
      : `Deleting ${rule.name} stops it running. The ${type === "classifier" ? "Categories it already assigned" : "fields it already extracted"} stay on their Items.`;
  return (
    <Disclosure
      label={<>Delete<span className="sr-only"> {rule.name}</span></>}
      openLabel={<>Keep it<span className="sr-only"> {rule.name}</span></>}
      className="sm:max-w-64"
      bodyClassName="border"
    >
      <p className="text-sm">
        {consequence} This can&apos;t be undone.
      </p>
      <form action={removeRuleAction.bind(null, type, rule.id)}>
        <SubmitButton variant="destructive" pendingLabel="Deleting…">
          Delete {ruleNoun[type]}
        </SubmitButton>
      </form>
    </Disclosure>
  );
}
