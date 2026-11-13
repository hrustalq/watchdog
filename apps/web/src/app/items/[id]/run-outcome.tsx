import type { ManualRun } from "@/lib/feed";
import { Notice } from "../../sign-in/notice";

/**
 * What a manual Extractor Rule run did, above its rule's button. The rule's name takes a line of its
 * own, so a name that reads like a verb can't run into the sentence under it, and that sentence names
 * the fields the run filled, found empty or couldn't store. A run that stored nothing wears the Caution
 * Amber lamp and says so in words, because it leaves the Item as a run that filled a field does not. A
 * failed run keeps Alarm Red, the provider's reason and the word that the rule's earlier values stayed.
 */
export function RunOutcome({ run }: { run: ManualRun }) {
  // A failed run stores no parts, so a run that has any is one that finished.
  const parts = run.fields.length > 0 || run.empty.length > 0 || run.problems.length > 0;
  const nothingStored = parts && run.fields.length === 0;
  const outcomes = [
    ...(run.fields.length === 0 ? [] : [`Filled ${run.fields.join(", ")}.`]),
    ...(run.empty.length === 0 ? [] : [`Found no value for ${run.empty.join(", ")}.`]),
    ...run.problems.map(({ name, reason }) => `Couldn't store ${name}: ${reason}`),
    // Every field found nothing and none was refused, so say the run left the Item alone.
    ...(nothingStored && run.problems.length === 0 ? ["Nothing was stored."] : []),
  ];
  // A row written before it carried these parts says only its own sentence.
  const lines = parts ? outcomes : [run.message];

  if (run.failed) {
    return (
      <Notice role="alert" className="flex items-start gap-2 text-sm text-alarm">
        <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm" />
        <span className="min-w-0 break-words">
          {/* An older row carries the reason in its sentence, which names the rule itself. */}
          {run.detail === undefined ? null : <RuleName name={run.extractor} />}
          {run.detail === undefined ? run.message : `The run failed: ${run.detail}`}
          <span className="block text-muted-foreground">What this rule found before stays as it was.</span>
        </span>
      </Notice>
    );
  }

  if (nothingStored) {
    return (
      <Notice role="status" className="flex items-start gap-2 rounded-lg bg-caution/10 px-3 py-2 text-sm text-caution">
        <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-caution" />
        <Lines name={run.extractor} lines={lines} />
      </Notice>
    );
  }

  return (
    <Notice role="status" className="rounded-lg bg-muted px-3 py-2 text-sm break-words">
      <Lines name={run.extractor} lines={lines} />
    </Notice>
  );
}

/** The rule's name on its own line, then what the run did, one outcome to a line. */
function Lines({ name, lines }: { name: string | undefined; lines: string[] }) {
  return (
    <span className="min-w-0 break-words">
      <RuleName name={name} />
      {lines.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
    </span>
  );
}

function RuleName({ name }: { name: string | undefined }) {
  if (name === undefined) return null;
  return (
    <span className="block font-medium">
      <span className="sr-only">Extractor Rule </span>
      {name}
    </span>
  );
}
