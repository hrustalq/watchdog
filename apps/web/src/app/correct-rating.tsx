// The controls that correct a Rating (DESIGN.md, "Correction controls"). They're plain forms, so they
// work without JavaScript. Each button posts one axis and the action keeps the other at its current
// level, and the buttons stay focusable at either end of the scale, so focus isn't lost by reaching it.
import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { field } from "@/components/field-classes";
import { ImportanceChip, SeverityChip } from "@/components/rating";
import { correctRatingAction } from "./actions";
import { CorrectionStatus } from "./correction-status";
import { SubmitButton } from "./sign-in/submit-button";

const axes = { severity: "Severity", importance: "Importance" };
type Axis = keyof typeof axes;

const levels = [1, 2, 3, 4, 5];

/** Dims while saving, which `CorrectionStatus` signals. */
const saving = "has-data-pending:opacity-60";

function Step({ axis, current, step, title }: { axis: Axis; current: number; step: -1 | 1; title: string }) {
  const lower = step < 0;
  const level = current + step;
  const inScale = level >= 1 && level <= 5;
  const Glyph = lower ? Minus : Plus;
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      {...(inScale
        ? { type: "submit", name: axis, value: String(level) }
        : { type: "button", "aria-disabled": true, className: "hover:bg-transparent dark:hover:bg-transparent" })}
    >
      {/* Only the glyph dims, so the focus ring stays at full strength. */}
      <Glyph aria-hidden="true" className={inScale ? undefined : "opacity-50"} />
      <span className="sr-only">
        {inScale
          ? `${lower ? "Lower" : "Raise"} ${axes[axis]} to ${String(level)}: ${title}`
          : `${axes[axis]} is at its ${lower ? "lowest" : "highest"}: ${title}`}
      </span>
    </Button>
  );
}

/** What a Rating's status says once a Correction has gone through. */
const ratingResult = (severity: number | null, importance: number | null) =>
  severity === null || importance === null
    ? "Still unrated"
    : `Now Severity ${String(severity)} of 5, Importance ${String(importance)} of 5`;

/**
 * A rated Item's chips in a Feed row in editing mode, each between one-click buttons a level down and
 * up. A row has four buttons rather than the whole scale, because each one is a tab stop.
 */
export function RatingStepper({
  itemId,
  title,
  severity,
  importance,
}: {
  itemId: string;
  title: string;
  severity: number;
  importance: number;
}) {
  return (
    // Positioned, so it sits above the title's link that covers the row.
    <form
      action={correctRatingAction}
      className={`relative inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${saving}`}
    >
      <input type="hidden" name="itemId" value={itemId} />
      <CorrectionStatus result={ratingResult(severity, importance)} />
      <span className="inline-flex items-center">
        <Step axis="severity" current={severity} step={-1} title={title} />
        {/* The row's link names the chips by these ids as its description. */}
        <SeverityChip id={`rating-${itemId}-severity`} value={severity} />
        <Step axis="severity" current={severity} step={1} title={title} />
      </span>
      <span className="inline-flex items-center">
        <Step axis="importance" current={importance} step={-1} title={title} />
        <ImportanceChip id={`rating-${itemId}-importance`} value={importance} />
        <Step axis="importance" current={importance} step={1} title={title} />
      </span>
    </form>
  );
}

function Scale({ axis, current }: { axis: Axis; current: number }) {
  return (
    <div role="group" aria-label={`Correct ${axes[axis]}`} className="flex items-center gap-1">
      <span aria-hidden="true" className="w-18 text-xs font-medium tracking-[0.01em] text-muted-foreground">
        {axes[axis]}
      </span>
      {levels.map((level) => (
        <Button
          key={level}
          // The current level posts nothing, and stays focusable after its click made it current.
          {...(level === current ? { type: "button" } : { type: "submit", name: axis, value: String(level) })}
          size="icon-xs"
          variant={level === current ? "default" : "ghost"}
          aria-current={level === current ? "true" : undefined}
          // Forced colors drop the fill, which would hide which level is the current one.
          className={`font-mono ${level === current ? "forced-color-adjust-none forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]" : ""}`}
        >
          <span aria-hidden="true">{level}</span>
          <span className="sr-only">{`Set ${axes[axis]} to ${String(level)} of 5`}</span>
        </Button>
      ))}
    </div>
  );
}

function Choice({ axis }: { axis: Axis }) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium tracking-[0.01em] text-muted-foreground">
      {axes[axis]}
      {/* Empty is where it starts, not a mistake, and the browser still refuses to submit it. */}
      <select
        name={axis}
        required
        aria-invalid={false}
        defaultValue=""
        className={`${field} w-auto bg-background text-foreground invalid:text-muted-foreground`}
      >
        <option value="" disabled>
          Choose
        </option>
        {levels.map((level) => (
          <option key={level} value={level}>
            {level} of 5
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The Item's own controls. A rated Item gets the whole scale on each axis, one click to any level. An
 * unrated one has to get both axes at once, because a Correction is sent to the Agent as the user's
 * judgement and a guess at the other axis would be taught to it as one.
 */
export function RatingControls({
  itemId,
  severity,
  importance,
}: {
  itemId: string;
  severity: number | null;
  importance: number | null;
}) {
  return (
    <form action={correctRatingAction} className={`flex flex-wrap items-center gap-x-4 gap-y-2 ${saving}`}>
      <input type="hidden" name="itemId" value={itemId} />
      <CorrectionStatus result={ratingResult(severity, importance)} />
      {severity === null || importance === null ? (
        <>
          <Choice axis="severity" />
          <Choice axis="importance" />
          <SubmitButton variant="outline" pendingLabel="Saving…" className="w-auto">
            Save Rating
          </SubmitButton>
        </>
      ) : (
        <>
          <Scale axis="severity" current={severity} />
          <Scale axis="importance" current={importance} />
        </>
      )}
    </form>
  );
}
