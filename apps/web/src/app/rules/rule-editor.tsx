"use client";

import { draftToYaml } from "@watchdog/core/rules/draft";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { fieldError, textBox } from "@/components/field-classes";
import { buttonVariants } from "@/components/ui/button";
import { type Draft, formShows, kindOf, readDraft, type RuleProblem, yamlWithoutScript } from "@/lib/rule-draft";
import type { RuleTarget } from "@/lib/rules";
import { cn } from "@/lib/utils";
import { SubmitButton } from "../sign-in/submit-button";
import { saveRuleAction } from "./actions";
import { RuleForm } from "./rule-form";
import { appliesFromNow, modelLink } from "./words";

const yamlBox = cn(textBox, "min-h-80 py-2 font-mono text-[0.8125rem] leading-[1.5] sm:text-[0.8125rem]");

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
  const [state, formAction] = useActionState(saveRuleAction.bind(null, target), { problems: initialProblems });
  // Problems point at places in the draft, so a change to its shape puts them out of date.
  const [cleared, setCleared] = useState<typeof state | null>(null);
  const problems = cleared === state ? [] : state.problems;

  const [first] = useState(() => readDraft(initialYaml));
  const [draft, setDraft] = useState<Draft>("draft" in first ? first.draft : {});
  const [yaml, setYaml] = useState(initialYaml);
  const [view, setView] = useState<"form" | "yaml">("draft" in first ? "form" : "yaml");
  const [unreadable, setUnreadable] = useState<string | null>(null);

  function showForm() {
    const read = readDraft(yaml);
    if ("error" in read) {
      setUnreadable(read.error);
      return;
    }
    setDraft(read.draft);
    setUnreadable(null);
    setView("form");
  }

  function showYaml() {
    setYaml(draftToYaml(draft));
    setView("yaml");
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <noscript>
        <div className="flex flex-col gap-2">
          <label htmlFor="rule-yaml-noscript" className="text-xs font-medium tracking-[0.01em]">
            Rule as YAML
          </label>
          <textarea
            id="rule-yaml-noscript"
            name={yamlWithoutScript}
            defaultValue={initialYaml}
            spellCheck={false}
            aria-invalid={initialProblems.length > 0}
            className={yamlBox}
          />
          <p className="text-xs text-muted-foreground">The Form view needs JavaScript. YAML writes the same rule.</p>
          <ProblemList problems={initialProblems} />
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

        {kindOf(draft) === "agent" && !hasModel ? (
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
            <label htmlFor="rule-yaml" className="text-xs font-medium tracking-[0.01em]">
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
              aria-describedby={unreadable === null ? undefined : "rule-yaml-unreadable"}
              className={yamlBox}
            />
            {unreadable === null ? null : (
              <p id="rule-yaml-unreadable" role="alert" className={cn(fieldError, "font-mono break-words whitespace-pre-wrap")}>
                The Form view can&apos;t show this yet. {unreadable}
              </p>
            )}
            <ProblemList problems={problems} />
          </div>
        )}

        {/* What the server is sent, from whichever view is open. */}
        <input type="hidden" name="yaml" value={view === "yaml" ? yaml : draftToYaml(draft)} />
      </div>

      <div className="flex flex-col gap-3 border-t pt-4">
        {problems.length === 0 ? null : (
          <div role="alert" className="flex flex-col gap-1">
            <p className={fieldError}>
              Not saved. {problems.length === 1 ? "1 problem needs" : `${String(problems.length)} problems need`} fixing
              {view === "form" ? " first." : ", listed above."}
            </p>
            {view === "form" ? (
              <ProblemList problems={problems.filter((problem) => !formShows(problem.path))} />
            ) : null}
          </div>
        )}
        <p className="text-sm text-muted-foreground">{appliesFromNow}</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <SubmitButton pendingLabel="Saving…" className="sm:w-auto">
            Save rule
          </SubmitButton>
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
function ProblemList({ problems }: { problems: RuleProblem[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1">
      {problems.map((problem) => (
        <li key={`${problem.path}:${problem.message}`} className={cn(fieldError, "break-words whitespace-pre-wrap")}>
          {problem.path === "" ? null : <code className="font-mono font-normal">{problem.path}: </code>}
          {problem.message}
        </li>
      ))}
    </ul>
  );
}
