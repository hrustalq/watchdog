import type { Metadata } from "next";
import Link from "next/link";
import { dataBox, field, fieldError, label as labelClass } from "@/components/field-classes";
import { buttonVariants } from "@/components/ui/button";
import { type PriceInput, type PriceProblem, priceProblemMessage, priceProblems } from "@/lib/model";
import { hasActiveModel } from "@/lib/rules";
import { requireWorkspace, server } from "@/lib/server";
import {
  formatCost,
  isFloor,
  monthLabel,
  parseMonth,
  purposeLabel,
  shiftMonth,
  usageForMonth,
  type UsageTally,
} from "@/lib/usage";
import { cn } from "@/lib/utils";
import { modelLink } from "../rules/words";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { setPricesAction } from "./actions";
import { MonthNav } from "./month-nav";

export const metadata: Metadata = { title: "Usage · Watchdog" };

// The data is read without Suspense, because there's nothing to show until it's there and the month
// links then work without JavaScript.
export const instant = false;

const textLink =
  "inline-flex min-h-6 items-center rounded-sm text-foreground underline underline-offset-4 outline-hidden focus-visible:ring-3 focus-visible:ring-ring/60";
const notes = "flex max-w-[70ch] flex-col gap-1 text-sm text-muted-foreground";
const noticeClass = "rounded-lg bg-muted px-3 py-2 text-sm";
const noPrices = "No prices";

const priceFields = [
  { name: "inputPrice", problem: "input-price", label: "Input price" },
  { name: "outputPrice", problem: "output-price", label: "Output price" },
] as const;

const calls = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "call" : "calls"}`;

export default async function UsagePage({ searchParams }: PageProps<"/usage">) {
  const [{ workspace }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const now = new Date();
  const current = parseMonth(undefined, now);
  const month = parseMonth(params.month, now);
  const { db } = server();
  const { models, purposes, total, firstMonth } = await usageForMonth(db, workspace.id, month);
  const older = firstMonth !== undefined && firstMonth < month ? shiftMonth(month, -1) : undefined;
  const newer = month < current ? shiftMonth(month, 1) : undefined;

  const param = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  // This comes from the URL, so only a known code counts, and each only picks words written here.
  const error = priceProblems.find((known) => known === param("error"));
  /** The refusal a row's form came back with, if it was that row's. */
  const refusal = (id: string) => {
    if (error !== "input-price" && error !== "output-price") return undefined;
    return param("modelId") === id ? error : undefined;
  };
  const priceValues = (id: string): PriceInput =>
    param("modelId") === id
      ? { inputPrice: param("inputPrice"), outputPrice: param("outputPrice") }
      : { inputPrice: "", outputPrice: "" };

  return (
    <div className="flex flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="flex h-12 items-center gap-2 border-b px-4 text-sm">
        <Link
          href="/"
          className="rounded-sm text-muted-foreground underline-offset-4 outline-hidden hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/60"
        >
          Workspace
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">
          /
        </span>
        <span aria-current="page">Usage</span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h1 className="text-headline">Usage</h1>
            <MonthNav current={current} older={older} newer={newer} />
          </div>
          <p className="text-title">
            {monthLabel(month)}
            {month === current ? <span className="font-normal text-muted-foreground"> so far</span> : null}
          </p>
          <div className={notes}>
            <p>Months are in UTC. Every attempt counts as a call, a retry included.</p>
            {total.withoutTokens === 0 ? null : (
              <p>
                {calls(total.withoutTokens)} came back without token counts, so token totals may be understated
                {total.cost === null ? "." : ", and ≥ marks an estimate that leaves them out."}
              </p>
            )}
            {total.unpricedCalls === 0 || total.cost === null ? null : (
              <p>{calls(total.unpricedCalls)} ran on a model without prices, so ≥ marks an estimate that leaves them out.</p>
            )}
          </div>
        </div>

        {param("saved") === "prices" ? (
          <Notice role="status" className={noticeClass}>
            Prices saved. Every month&apos;s estimate now includes the calls that ran on that model.
          </Notice>
        ) : null}
        {error === "model" ? (
          <Notice role="alert" className={noticeClass}>
            {priceProblemMessage.model}
          </Notice>
        ) : null}

        {total.calls === 0 ? (
          <EmptyMonth
            label={monthLabel(month)}
            neverCalled={firstMonth === undefined}
            hasModel={await hasActiveModel(db, workspace.id)}
          />
        ) : (
          <>
            <UsageTable
              id="by-model"
              title="By model"
              rowHead="Model"
              rows={models.map((model) => ({
                key: model.id,
                tally: model,
                label: (
                  <>
                    <span className="font-mono text-[0.8125rem] wrap-anywhere">{model.modelName}</span>
                    <span className="block font-mono text-xs wrap-anywhere text-muted-foreground">{model.baseUrl}</span>
                    {model.archived ? (
                      <span className="mt-1 inline-block rounded-sm bg-muted px-1.5 py-0.5 text-xs font-medium tracking-[0.01em]">
                        Archived
                      </span>
                    ) : null}
                  </>
                ),
                // The active model's prices change on the Model screen. An archived one has no form
                // there, so the Usage screen sets them in place.
                noCost: model.archived ? (
                  <PriceForm
                    id={model.id}
                    month={month}
                    problem={refusal(model.id)}
                    values={priceValues(model.id)}
                  />
                ) : (
                  <Link href={modelLink} className={textLink}>
                    Set prices
                  </Link>
                ),
              }))}
              total={models.length > 1 ? total : undefined}
              showCost
            />
            <UsageTable
              id="by-purpose"
              title="By purpose"
              rowHead="Purpose"
              rows={purposes.map((row) => ({
                key: row.purpose,
                tally: row,
                label: purposeLabel[row.purpose],
                noCost: noPrices,
              }))}
              // Models carries the link to set prices, so with none set this column would say nothing.
              showCost={purposes.some((row) => row.cost !== null)}
            />
            {total.cost === null ? null : (
              <p className={notes}>
                Estimated cost is tokens times the prices each call&apos;s model had when the call was made,
                taking every price to be in one currency. It isn&apos;t your provider&apos;s bill.
              </p>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function EmptyMonth({ label, neverCalled, hasModel }: { label: string; neverCalled: boolean; hasModel: boolean }) {
  const words = "mt-2 max-w-md text-sm text-muted-foreground";
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-16 text-center">
      <h2 className="text-headline">{neverCalled ? "No Agent calls yet" : `No Agent calls in ${label}`}</h2>
      {hasModel && neverCalled ? (
        <p className={words}>Calls show up here once the Agent rates an Item or you test the connection.</p>
      ) : null}
      {hasModel ? null : (
        <>
          <p className={words}>The Agent runs on a model you bring, and this Workspace has none.</p>
          <Link href={modelLink} className={buttonVariants({ className: "mt-6" })}>
            Add a model
          </Link>
        </>
      )}
    </div>
  );
}

const reading = "px-4 py-2 text-right align-top font-mono text-[0.8125rem] whitespace-nowrap";
const columnHead = "px-4 py-2 text-right font-medium whitespace-nowrap";
// Stays in view while a phone scrolls the readings, so each one still says whose it is.
const firstColumn = "sticky left-0 bg-background px-4 py-2 text-left align-top";
// No `whitespace-nowrap`: the archived model's form wraps inside this cell.
const noneCell = "px-4 py-2 text-right align-top text-sm text-muted-foreground";

/**
 * Prices an archived model, which the Model screen can't change, from the cost cell it can't fill.
 * It's a native disclosure like the Remove confirmation, so it opens and saves without JavaScript.
 */
function PriceForm({
  id,
  month,
  problem,
  values,
}: {
  id: string;
  month: string;
  problem: PriceProblem | undefined;
  values: PriceInput;
}) {
  return (
    <details open={problem !== undefined} className="group flex flex-col items-end gap-1">
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center rounded-sm text-sm underline underline-offset-4 select-none outline-hidden hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/60 group-open:no-underline [&::-webkit-details-marker]:hidden">
        {noPrices}
      </summary>
      <form action={setPricesAction} className="mt-1 flex w-44 flex-col gap-2 text-left">
        <input type="hidden" name="month" value={month} />
        <input type="hidden" name="modelId" value={id} />
        {priceFields.map(({ name, problem: fieldProblem, label }) => {
          const invalid = problem === fieldProblem;
          const noteId = `${id}-${name}-note`;
          return (
            <div key={name} className="flex flex-col gap-1">
              <label htmlFor={`${id}-${name}`} className={labelClass}>
                {label}
              </label>
              <input
                id={`${id}-${name}`}
                name={name}
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                defaultValue={values[name]}
                aria-invalid={invalid}
                aria-describedby={invalid ? noteId : undefined}
                className={`${field} ${dataBox} tabular-nums`}
              />
              {/* A notice moves focus to itself, so a refusal left in a URL is announced and
                  scrolled into view on the phone this cell scrolls on. */}
              {invalid ? (
                <Notice role="alert" className={fieldError}>
                  {priceProblemMessage[fieldProblem]}
                </Notice>
              ) : null}
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">Per million tokens, for every month.</p>
        <SubmitButton pendingLabel="Saving…" className="w-full">
          Save prices
        </SubmitButton>
      </form>
    </details>
  );
}

function CostCell({ tally, none }: { tally: UsageTally; none: React.ReactNode }) {
  if (tally.cost === null) {
    return <td className={noneCell}>{none}</td>;
  }
  return (
    <td className={reading}>
      {isFloor(tally) ? (
        <>
          <span aria-hidden="true">≥ </span>
          <span className="sr-only">At least </span>
        </>
      ) : null}
      {formatCost(tally.cost)}
    </td>
  );
}

function UsageTable({
  id,
  title,
  rowHead,
  rows,
  total,
  showCost,
}: {
  id: string;
  title: string;
  rowHead: string;
  rows: { key: string; label: React.ReactNode; tally: UsageTally; noCost: React.ReactNode }[];
  total?: UsageTally | undefined;
  showCost: boolean;
}) {
  const readings = (tally: UsageTally, none: React.ReactNode) => (
    <>
      {showCost ? <CostCell tally={tally} none={none} /> : null}
      {(["calls", "failed", "inputTokens", "outputTokens"] as const).map((column) => (
        <td key={column} className={reading}>
          {tally[column].toLocaleString("en-US")}
        </td>
      ))}
    </>
  );
  return (
    <div className="flex flex-col gap-2">
      <h2 id={id} className="text-title">
        {title}
      </h2>
      {/* Six columns don't fit a phone, so this scrolls by itself, with the cost first to be seen. */}
      <div
        role="region"
        aria-labelledby={id}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- so a keyboard can scroll it
        tabIndex={0}
        className="overflow-x-auto rounded-lg border outline-hidden focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/60"
      >
        <table className="w-full min-w-xl text-sm">
          <thead className="border-b text-xs tracking-[0.01em] text-muted-foreground">
            <tr>
              <th scope="col" className={cn(firstColumn, "font-medium")}>
                {rowHead}
              </th>
              {showCost ? (
                <th scope="col" className={columnHead}>
                  Estimated cost
                </th>
              ) : null}
              <th scope="col" className={columnHead}>
                Calls
              </th>
              <th scope="col" className={columnHead}>
                Failed
              </th>
              <th scope="col" className={columnHead}>
                Input tokens
              </th>
              <th scope="col" className={columnHead}>
                Output tokens
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((row) => (
              <tr key={row.key}>
                <th scope="row" className={cn(firstColumn, "min-w-40 font-normal")}>
                  {row.label}
                </th>
                {readings(row.tally, row.noCost)}
              </tr>
            ))}
          </tbody>
          {total === undefined ? null : (
            <tfoot className="border-t font-medium">
              <tr>
                <th scope="row" className={cn(firstColumn, "font-medium")}>
                  Total
                </th>
                {readings(total, noPrices)}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
