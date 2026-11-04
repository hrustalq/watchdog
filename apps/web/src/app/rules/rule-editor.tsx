"use client";

import { draftToYaml } from "@watchdog/core/rules/draft";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { dataBox, fieldError, label, textBox } from "@/components/field-classes";
import { Button, buttonVariants } from "@/components/ui/button";
import { type Draft, formShows, kindOf, readDraft, type RuleProblem, yamlWithoutScript } from "@/lib/rule-draft";
import type { RuleTarget } from "@/lib/rules";
import { cn } from "@/lib/utils";
import { saveRuleAction } from "./actions";
import { RuleForm } from "./rule-form";
import { appliesFromNow, modelLink } from "./words";

const yamlBox = cn(textBox, dataBox, "min-h-80 py-2 leading-[1.5]");

interface RuleEditorProps {
  target: RuleTarget | null;
  initialYaml: string;
  initialProblems: RuleProblem[];
  hasModel: boolean;
  sources: { id: string; name: string }[];
}

/**
 * Next.js keeps a page's state when it's navigated away from (Activity), which would show the last
 * rule in "New", or an abandoned edit when a rule is opened again. A link starts from what the server
 * says, and Back still restores a draft in progress. So does a rule the server has changed since.
 */
export function RuleEditor(props: RuleEditorProps) {
  const { bfcacheId } = useRouter();
  return <Editor key={`${bfcacheId}:${props.initialYaml}`} {...props} />;
}

/**
 * The Form and YAML views of one draft. The draft can be anything while it's being written: it's
 * only checked when saved, on the server, so moving between the views can't lose a value. Whichever
 * view is open, the server is sent YAML.
 */
function Editor({ target, initialYaml, initialProblems, hasModel, sources }: RuleEditorProps) {
  const [state, formAction, pending] = useActionState(saveRuleAction.bind(null, target), {
    problems: initialProblems,
  });
  const formRef = useRef<HTMLFormElement>(null);
  // Problems point at places in the draft, so a change to its shape puts them out of date.
  const [cleared, setCleared] = useState<typeof state | null>(null);
  const problems = cleared === state ? [] : state.problems;

  const [first] = useState(() => readDraft(initialYaml));
  const [draft, setDraft] = useState<Draft>("draft" in first ? first.draft : {});
  const [yaml, setYaml] = useState(initialYaml);
  const [view, setView] = useState<"form" | "yaml">("draft" in first ? "form" : "yaml");
  const [unreadable, setUnreadable] = useState<string | null>(null);
  const [sent, setSent] = useState(initialYaml);
  // The YAML view is the draft while it's open, so what it says now decides the notice below.
  const readYaml = view === "yaml" ? readDraft(yaml) : undefined;
  const current = readYaml !== undefined && "draft" in readYaml ? readYaml.draft : draft;

  // A refusal moves focus to the first thing to fix, as on Sources.
  useEffect(() => {
    if (state.problems.length === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]')?.focus();
  }, [state]);

  function showForm() {
    const read = readDraft(yaml);
    if ("error" in read) {
      setUnreadable(read.error);
      return;
    }
    // The problems are about the text that was sent, so edited YAML puts their places out of date.
    if (yaml !== sent) setCleared(state);
    setDraft(read.draft);
    setUnreadable(null);
    setView("form");
  }

  function showYaml() {
    setYaml(draftToYaml(draft));
    setView("yaml");
  }

  return (
    <form
      ref={formRef}
      // Only for a browser without JavaScript. With it, React would reset the form after the action,
      // and a select goes back to its first option while the draft still holds another.
      action={formAction}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setSent(view === "yaml" ? yaml : draftToYaml(draft));
        startTransition(() => {
          formAction(data);
        });
      }}
      className="flex flex-col gap-6"
    >
      <noscript>
        <div className="flex flex-col gap-2">
          <label htmlFor="rule-yaml-noscript" className={label}>
            Rule as YAML
          </label>
          <textarea
            id="rule-yaml-noscript"
            name={yamlWithoutScript}
            defaultValue={initialYaml}
            spellCheck={false}
            aria-invalid={initialProblems.length > 0}
            aria-describedby="rule-yaml-noscript-problems"
            className={yamlBox}
          />
          <p className="text-xs text-muted-foreground">The Form view needs JavaScript. YAML writes the same rule.</p>
          <ProblemList id="rule-yaml-noscript-problems" problems={initialProblems} />
        </div>
      </noscript>

      {/* Hidden without JavaScript, where nothing here could respond. */}
      <div className="flex flex-col gap-6 [@media(scripting:none)]:hidden">
        <div role="group" aria-label="View" className="inline-flex self-start rounded-lg border p-0.5">
          <ViewButton selected={view === "form"} onClick={showForm}>
            Form
          </ViewButton>
          <ViewButton selected={view === "yaml"} onClick={showYaml}>
            YAML
          </ViewButton>
        </div>

        {kindOf(current) === "agent" && !hasModel ? (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm">
            This Agent-backed rule stays disabled until this Workspace has a model. You can still save
            it.{" "}
            <Link href={modelLink} className="rounded-sm underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
              Set up a model
            </Link>
          </p>
        ) : null}

        {view === "form" ? (
          <RuleForm
            draft={draft}
            sources={sources}
            problems={problems}
            onEdit={setDraft}
            onReshape={(next) => {
              setDraft(next);
              setCleared(state);
            }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <label htmlFor="rule-yaml" className={label}>
              Rule as YAML
            </label>
            <textarea
              id="rule-yaml"
              value={yaml}
              onChange={(event) => {
                setYaml(event.target.value);
                setUnreadable(null);
              }}
              spellCheck={false}
              aria-invalid={problems.length > 0 || unreadable !== null}
              aria-describedby={unreadable === null ? "rule-yaml-problems" : "rule-yaml-unreadable rule-yaml-problems"}
              className={yamlBox}
            />
            {unreadable === null ? null : (
              <div id="rule-yaml-unreadable" role="alert" className={cn(fieldError, "flex flex-col gap-1")}>
                <p>The Form view can&apos;t show this yet.</p>
                <pre className="font-mono font-normal break-words whitespace-pre-wrap">{unreadable}</pre>
              </div>
            )}
            <ProblemList id="rule-yaml-problems" problems={problems} />
          </div>
        )}

        {/* What the server is sent, from whichever view is open. */}
        <input type="hidden" name="yaml" value={view === "yaml" ? yaml : draftToYaml(draft)} />
      </div>

      <div className="flex flex-col gap-3 border-t pt-4">
        {problems.length === 0 ? null : (
          <div role="alert" tabIndex={-1} className="flex flex-col gap-1 outline-none">
            <p className={fieldError}>
              Not saved. {problems.length === 1 ? "1 problem needs" : `${String(problems.length)} problems need`} fixing
              {view === "form" ? " first." : ", listed above."}
            </p>
            {/* Without JavaScript, the list beside the YAML box has them all. */}
            {view === "form" ? (
              <div className="[@media(scripting:none)]:hidden">
                <ProblemList problems={problems.filter((problem) => !formShows(problem.path))} />
              </div>
            ) : null}
          </div>
        )}
        <p className="text-sm text-muted-foreground">{appliesFromNow}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="submit" disabled={pending} className="w-full sm:w-auto">
            {pending ? "Saving…" : "Save rule"}
          </Button>
          <Link href="/rules" className={buttonVariants({ variant: "ghost" })}>
            Cancel
          </Link>
        </div>
      </div>
    </form>
  );
}

function ViewButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={selected ? undefined : onClick}
      className={cn(
        "h-7 rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
        selected ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Problems with where each one is, for a view that has no field to put them beside. */
function ProblemList({ id, problems }: { id?: string; problems: RuleProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul id={id} className="flex flex-col gap-1">
      {problems.map((problem) => (
        <li key={`${problem.path}:${problem.message}`} className={cn(fieldError, "break-words whitespace-pre-wrap")}>
          {problem.path === "" ? null : <code className="font-mono font-normal">{problem.path}: </code>}
          {problem.message}
        </li>
      ))}
    </ul>
  );
}
