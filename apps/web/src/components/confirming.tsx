import { SubmitButton } from "@/app/sign-in/submit-button";

/** A control whose result can't be undone, opened first. A disclosure works without JavaScript. */
export function Confirming({
  label: opener,
  name,
  warning,
  action,
  button,
  pendingLabel,
}: {
  label: string;
  /** What it acts on, for a screen reader tabbing through several rows of the same controls. */
  name: string;
  warning: string;
  action: () => Promise<void>;
  button: string;
  pendingLabel: string;
}) {
  return (
    <details className="group">
      <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg border border-transparent px-3 text-sm font-medium outline-hidden select-none hover:bg-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 group-open:bg-muted dark:hover:bg-muted/50 [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">{opener}</span>
        <span className="hidden group-open:inline">Keep it</span>
        <span className="sr-only"> {name}</span>
      </summary>
      <div className="mt-2 flex flex-col gap-3 rounded-lg bg-muted p-3">
        <p className="text-sm">{warning}</p>
        <form action={action}>
          <SubmitButton variant="destructive" pendingLabel={pendingLabel}>
            {button}
            <span className="sr-only"> {name}</span>
          </SubmitButton>
        </form>
      </div>
    </details>
  );
}
