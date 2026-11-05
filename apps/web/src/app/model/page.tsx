import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { Timestamp } from "@/components/timestamp";
import { buttonVariants } from "@/components/ui/button";
import {
  getModel,
  lastFailedCall,
  modelProblems,
  providerTypes,
  type StoredKey,
  testOutcomes,
  type TestOutcome,
} from "@/lib/model";
import { requireWorkspace, server } from "@/lib/server";
import { Notice } from "../sign-in/notice";
import { SubmitButton } from "../sign-in/submit-button";
import { removeModelAction, testConnectionAction } from "./actions";
import { ModelForm, type ModelFormValues } from "./model-form";

export const metadata: Metadata = { title: "Model · Watchdog" };

export default function ModelPage({ searchParams }: PageProps<"/model">) {
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
        <span aria-current="page">Model</span>
      </nav>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
        <h1 className="text-headline">Model</h1>
        {/* The form shows the saved model, so an empty one in the static shell could replace it. This
            screen therefore needs JavaScript, unlike the form on Sources. */}
        <Suspense fallback={<div aria-busy="true" className="h-96 rounded-lg bg-muted" />}>
          <ModelScreen searchParams={searchParams} />
        </Suspense>
      </main>
    </div>
  );
}

const blankForm: ModelFormValues = {
  providerType: "openai-compatible",
  baseUrl: "",
  modelName: "",
  structured: false,
  inputPrice: "",
  outputPrice: "",
};

const noticeClass = "rounded-lg bg-muted px-3 py-2 text-sm";
const keyLink =
  "rounded-sm text-foreground underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30";

async function ModelScreen({ searchParams }: Pick<PageProps<"/model">, "searchParams">) {
  const [{ workspace }, params] = await Promise.all([requireWorkspace(), searchParams]);
  const { db, encryptionKey, mode } = server();
  const [model, failure] = await Promise.all([
    getModel(db, encryptionKey, workspace.id),
    lastFailedCall(db, workspace.id),
  ]);

  const param = (name: string) => {
    const value = params[name];
    return typeof value === "string" ? value : "";
  };
  // These come from the URL, so only a known code counts, and each only picks words written here.
  const problem = modelProblems.find((known) => known === param("error"));
  const test = testOutcomes.find((known) => known === param("test"));

  const saved: ModelFormValues =
    model === undefined
      ? blankForm
      : {
          providerType: model.providerType,
          baseUrl: model.baseUrl,
          modelName: model.modelName,
          structured: model.supportsStructuredOutput,
          inputPrice: model.inputPricePerMillion?.toString() ?? "",
          outputPrice: model.outputPricePerMillion?.toString() ?? "",
        };
  const values: ModelFormValues =
    problem === undefined
      ? saved
      : {
          providerType: param("providerType"),
          baseUrl: param("baseUrl"),
          modelName: param("modelName"),
          structured: param("structured") !== "",
          inputPrice: param("inputPrice"),
          outputPrice: param("outputPrice"),
        };

  return (
    <>
      {param("saved") === "1" ? (
        <Notice role="status" className={noticeClass}>
          {model?.storedKey === "unreadable"
            ? "Model saved, but its API key is still unreadable."
            : "Model saved. Test the connection to check that it works."}
        </Notice>
      ) : null}
      {param("saved") === "key-left-behind" ? (
        <Notice role="status" className={noticeClass}>
          Model saved with no API key. The old key was only for the old address, so Watchdog deleted it.{" "}
          <a href="#api-key" className={keyLink}>
            Enter this model&apos;s key
          </a>
          , unless it needs none.
        </Notice>
      ) : null}
      {param("removed") !== "" ? (
        <Notice role="status" className={noticeClass}>
          Model removed. Agent stages have stopped and new Items stay unrated. Deterministic rules keep running.
        </Notice>
      ) : null}

      {model === undefined ? null : (
        <section aria-labelledby="current-model" className="flex flex-col gap-3 rounded-lg border p-4">
          <div className="flex flex-col gap-1">
            <h2 id="current-model" className="text-title font-mono break-words">
              {model.modelName}
            </h2>
            <p className="font-mono text-[0.8125rem] break-all text-muted-foreground">{model.baseUrl}</p>
            <p className="text-sm text-muted-foreground">
              {providerTypes.find(({ value }) => value === model.providerType)?.label}
              {" · "}
              {keyStatus[model.storedKey]}
            </p>
          </div>
          {/* The URL can outlive the test: "Connected" mustn't sit above a newer failure. */}
          <TestResult
            test={test === "ok" && (failure?.recovered === false || model.storedKey === "unreadable") ? undefined : test}
            modelName={model.modelName}
          />
          {model.storedKey === "unreadable" ? <UnreadableKey justTested={test === "unreadable-key"} mode={mode} /> : null}
          {/* An older failure, or "A later call worked", says nothing about a key that can't be read. */}
          {failure === undefined || model.storedKey === "unreadable" ? null : (
            <FailedCall
              failure={failure}
              // A test that just failed is why the user is reading this line.
              justFailed={test === "failed" || test === "blocked"}
              hint={test === "blocked" ? blockedHint(mode) : undefined}
            />
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            {/* A test can't help while the key is unreadable: it makes no call, and the screen already knows. */}
            {model.storedKey === "unreadable" ? (
              <a href="#api-key" className={`${buttonVariants()} w-full sm:w-auto`}>
                Enter the key again
              </a>
            ) : (
              <div className="flex flex-col gap-1">
                <form action={testConnectionAction}>
                  <SubmitButton variant="outline" pendingLabel="Testing…" className="sm:w-auto">
                    Test connection
                  </SubmitButton>
                </form>
                <p className="text-xs text-muted-foreground">
                  One small call to the saved model, which your provider bills as usual.
                </p>
              </div>
            )}
            <RemoveModel name={model.modelName} />
          </div>
        </section>
      )}

      <section aria-labelledby="model-form" className="flex flex-col gap-4 rounded-lg border p-4">
        <h2 id="model-form" className="text-title">
          {model === undefined ? "Add a model" : "Change the model"}
        </h2>
        <p className="text-sm text-muted-foreground">{formIntro(model)}</p>
        {/* A new key on the saved values remounts nothing, so React's own form reset clears the field. */}
        <ModelForm
          key={JSON.stringify(values)}
          values={values}
          storedKey={model?.storedKey ?? "none"}
          problem={problem}
          keyTyped={param("keyTyped") !== ""}
        />
      </section>
    </>
  );
}

function formIntro(model: Awaited<ReturnType<typeof getModel>>) {
  if (model === undefined) {
    return "Bring your own model to get Items rated and Agent-backed rules running. Without one, deterministic rules still run and Items stay unrated.";
  }
  const replaces = "A new provider type, base URL or model name replaces this model. Usage history keeps the old one.";
  return model.storedKey === "unreadable" ? `Enter the API key below, and leave the rest to keep this model. ${replaces}` : replaces;
}

const keyStatus: Record<StoredKey, string> = {
  none: "No API key",
  set: "API key set",
  unreadable: "API key unreadable",
};

const blockedHint = (mode: "hosted" | "self-hosted") =>
  mode === "self-hosted"
    ? "Whoever runs this Watchdog can allow a private address with EGRESS_ALLOWLIST."
    : "Hosted Watchdog only reaches public addresses.";

function TestResult({ test, modelName }: { test: TestOutcome | undefined; modelName: string }) {
  switch (test) {
    case "ok":
      return (
        <Notice role="status" className={noticeClass}>
          Connected. {modelName} answered.
        </Notice>
      );
    // The screen says this from the key itself, whether or not a test just ran.
    case "unreadable-key":
    case "blocked":
    case "failed":
    case "no-model":
    case undefined:
      return null;
  }
}

/** Something to fix. It takes focus only after a test: a page that merely loads with it shouldn't move it. */
function AlarmLine({ takeFocus, children }: { takeFocus: boolean; children: React.ReactNode }) {
  const className = "flex items-start gap-2 text-sm text-alarm";
  const line = (
    <>
      <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm" />
      {children}
    </>
  );
  return takeFocus ? (
    <Notice role="alert" className={className}>
      {line}
    </Notice>
  ) : (
    <p className={className}>{line}</p>
  );
}

/** Only whoever runs a self-hosted Watchdog can change the variable, or put its old value back. */
const UnreadableKey = ({ justTested, mode }: { justTested: boolean; mode: "hosted" | "self-hosted" }) => (
  <AlarmLine takeFocus={justTested}>
    <span className="min-w-0 break-words">
      Watchdog can&apos;t read the stored API key
      {mode === "self-hosted" ? (
        <>
          , which happens when <span className="font-mono text-[0.8125rem]">WATCHDOG_ENCRYPTION_KEY</span> changes
        </>
      ) : null}
      . Items captured until you enter the key again stay unrated, and deterministic rules keep running.
      {mode === "self-hosted" ? " If the change was a mistake, put the old value back instead." : null}
    </span>
  </AlarmLine>
);

function FailedCall({
  failure,
  justFailed,
  hint,
}: {
  failure: { at: Date; reason: string; recovered: boolean };
  justFailed: boolean;
  hint: string | undefined;
}) {
  const words = (
    <span className="min-w-0 break-words">
      Last failed call at <Timestamp at={failure.at} />: {failure.reason}
      {/* The reason is someone else's sentence, and may not end in a full stop. */}
      {failure.recovered ? <span className="block">A later call worked.</span> : null}
      {hint === undefined ? null : <span className="block text-muted-foreground">{hint}</span>}
    </span>
  );
  if (failure.recovered) return <p className="text-sm text-muted-foreground">{words}</p>;
  return <AlarmLine takeFocus={justFailed}>{words}</AlarmLine>;
}

/** Remove, then a confirmation in the page that says what goes with it, as on Sources. */
function RemoveModel({ name }: { name: string }) {
  return (
    <details className="group shrink-0 sm:max-w-64">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg px-3 text-sm font-medium outline-none select-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 group-open:bg-muted dark:hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Remove</span>
        <span className="hidden group-open:inline">Keep it</span>
      </summary>
      <div className="mt-2 flex flex-col gap-3 rounded-lg bg-muted p-3">
        <p className="text-sm break-words">
          Removing {name} forgets its API key and stops Agent stages, so new Items stay unrated. Deterministic rules keep
          running, and Usage history stays.
        </p>
        <form action={removeModelAction}>
          {/* Solid Alarm Red: the variant's red on a tint over this panel is under 4.5:1. */}
          <SubmitButton
            variant="destructive"
            pendingLabel="Removing…"
            className="bg-alarm text-alarm-foreground hover:bg-alarm/90 dark:bg-alarm dark:hover:bg-alarm/90"
          >
            Remove model
          </SubmitButton>
        </form>
      </div>
    </details>
  );
}
