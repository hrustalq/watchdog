import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { textLink } from "@/components/field-classes";
import { buttonVariants } from "@/components/ui/button";
import { type ActionKind, type RuleKind, ruleNoun, type RuleType } from "@/lib/rule-draft";
import { listRules } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { removeRuleAction, setRuleEnabledAction } from "./actions";
import { RulesBreadcrumb } from "./rules-breadcrumb";
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
      <RulesBreadcrumb />
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-headline">Rules</h1>
          <p className="text-sm text-muted-foreground">{appliesFromNow}</p>
        </div>
        {/* What the last save said is read from the URL, so it streams in. */}
        <Suspense fallback={null}>
          <SavedNotice searchParams={searchParams} />
        </Suspense>
        <section aria-labelledby="add-rule" className="flex flex-col gap-4 rounded-lg border p-4">
          <h2 id="add-rule" className="text-title">
            Add a rule
          </h2>
          <p className="text-sm text-muted-foreground">{kindsExplained}</p>
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
        </section>
        <Suspense fallback={<div aria-busy="true" className="h-48 rounded-lg bg-muted" />}>
          <RuleLists />
        </Suspense>
      </main>
    </div>
  );
}

async function SavedNotice({ searchParams }: Pick<PageProps<"/rules">, "searchParams">) {
  const { saved } = await searchParams;
  if (saved === undefined) return null;
  return (
    <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
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
  const { classifiers, extractorRules, actions, hasModel } = await listRules(server().db, workspace.id);
  return (
    <>
      <RuleList
        type="classifier"
        heading="Classifiers"
        empty="None yet. Items get no Categories until you add one."
        rules={classifiers}
        hasModel={hasModel}
      />
      <RuleList
        type="extractor"
        heading="Extractor Rules"
        empty="None yet. Items get no extracted fields until you add one."
        rules={extractorRules}
        hasModel={hasModel}
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
}: {
  type: RuleType;
  heading: string;
  note?: string;
  empty: string;
  rules: RuleRow[];
  hasModel: boolean;
}) {
  return (
    <section aria-labelledby={`${type}-rules`} className="flex flex-col gap-3">
      <h2 id={`${type}-rules`} className="text-title">
        {heading} <span className="font-normal text-muted-foreground tabular-nums">{rules.length}</span>
      </h2>
      {note === undefined ? null : <p className="text-sm text-muted-foreground">{note}</p>}
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rules.map((rule) => (
            <RuleItem key={rule.id} type={type} rule={rule} needsModel={rule.kind === "agent" && !hasModel} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RuleItem({ type, rule, needsModel }: { type: RuleType; rule: RuleRow; needsModel: boolean }) {
  return (
    <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="text-title break-words">
          <Link
            href={`/rules/${type}/${rule.id}`}
            className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30"
          >
            {rule.name}
          </Link>
        </h3>
        <p className="text-xs font-medium tracking-[0.01em] text-muted-foreground">{kindLabel[rule.kind]}</p>
        {rule.detail}
        {needsModel ? (
          <p className="text-sm text-muted-foreground">
            Disabled until this Workspace has a model.{" "}
            <Link href={modelLink} className="rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
              Set up a model
            </Link>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-start gap-2">
        <EnableSwitch type={type} rule={rule} locked={needsModel || rule.noDestination === true} />
        <DeleteRule type={type} rule={rule} />
      </div>
    </li>
  );
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
          Schedule <span className="font-mono text-[0.8125rem]">{schedule}</span>
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
  return (
    <p className="flex items-baseline gap-2 text-sm">
      <span aria-hidden="true" className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-caution" />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
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
        className="group flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent dark:hover:bg-muted/50"
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
    <details className="group sm:max-w-64">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg px-3 text-sm font-medium outline-none select-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 group-open:bg-muted dark:hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">
          Delete<span className="sr-only"> {rule.name}</span>
        </span>
        <span className="hidden group-open:inline">
          Keep it<span className="sr-only"> {rule.name}</span>
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-3 rounded-lg border p-3">
        <p className="text-sm">
          {consequence} This can&apos;t be undone.
        </p>
        <form action={removeRuleAction.bind(null, type, rule.id)}>
          {/* A lighter tint than the button's own, which leaves its text at 3.3:1. */}
          <SubmitButton variant="destructive" pendingLabel="Deleting…" className="dark:bg-destructive/15">
            Delete {ruleNoun[type]}
          </SubmitButton>
        </form>
      </div>
    </details>
  );
}
