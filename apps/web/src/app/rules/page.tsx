import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { buttonVariants } from "@/components/ui/button";
import { type RuleKind, ruleNoun, type RuleType } from "@/lib/rule-draft";
import { listRules } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { removeRuleAction, setRuleEnabledAction } from "./actions";
import { RulesBreadcrumb } from "./rules-breadcrumb";
import { appliesFromNow, kindLabel, kindsExplained, modelLink } from "./words";

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
          <div className="grid gap-4 sm:grid-cols-2">
            <AddRule type="classifier" description="Sorts every Item into Categories." />
            <AddRule
              type="extractor"
              description="Pulls structured fields out of the Items that meet its Condition."
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
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">{ruleNoun[type]}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="mt-auto flex flex-wrap gap-2">
        {newRule("deterministic")}
        {newRule("agent")}
      </div>
    </div>
  );
}

async function RuleLists() {
  const { workspace } = await requireWorkspace();
  const { classifiers, extractorRules, hasModel } = await listRules(server().db, workspace.id);
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
    </>
  );
}

interface RuleRow {
  id: string;
  name: string;
  kind: RuleKind;
  enabled: boolean;
}

function RuleList({
  type,
  heading,
  empty,
  rules,
  hasModel,
}: {
  type: RuleType;
  heading: string;
  empty: string;
  rules: RuleRow[];
  hasModel: boolean;
}) {
  return (
    <section aria-labelledby={`${type}-rules`} className="flex flex-col gap-3">
      <h2 id={`${type}-rules`} className="text-title">
        {heading} <span className="font-normal text-muted-foreground tabular-nums">{rules.length}</span>
      </h2>
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
        <EnableSwitch type={type} rule={rule} needsModel={needsModel} />
        <DeleteRule type={type} rule={rule} />
      </div>
    </li>
  );
}

/** A form with one button, so it works without JavaScript. The word says what color alone wouldn't. */
function EnableSwitch({ type, rule, needsModel }: { type: RuleType; rule: RuleRow; needsModel: boolean }) {
  const on = rule.enabled && !needsModel;
  return (
    <form action={setRuleEnabledAction.bind(null, type, rule.id, !rule.enabled)}>
      <button
        type="submit"
        role="switch"
        aria-checked={on}
        disabled={needsModel}
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
  const kept = type === "classifier" ? "Categories it already assigned" : "fields it already extracted";
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
          Deleting {rule.name} stops it running. The {kept} stay on their Items. This can&apos;t be
          undone.
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
