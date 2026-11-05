// The controls that correct a Rating (DESIGN.md, "Correction controls"). They're plain forms, so they
// work without JavaScript. Each button posts one axis and the action keeps the other at its current
// level, and the buttons stay focusable at either end of the scale, so focus isn't lost by reaching it.
import { type RatingAxis, ratingMeaning, ratingScale } from "@watchdog/core";
import { Minus, Plus } from "lucide-react";
import { field, label } from "@/components/field-classes";
import { ImportanceChip, SeverityChip } from "@/components/rating";
import { correctRatingAction } from "./actions";
import { CorrectionButton, CorrectionStatus } from "./correction-status";
import { SubmitButton } from "./sign-in/submit-button";

const levels = [1, 2, 3, 4, 5];

/** Dims while saving, which `CorrectionStatus` signals. */
const saving = "has-data-pending:opacity-60";

function Step({ axis, current, step, title }: { axis: RatingAxis; current: number; step: -1 | 1; title: string }) {
  const { name } = ratingScale[axis];
  const lower = step < 0;
  const level = current + step;
  const inScale = level >= 1 && level <= 5;
  const Glyph = lower ? Minus : Plus;
  return (
    <CorrectionButton
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
          ? `${lower ? "Lower" : "Raise"} ${name} to ${String(level)}, ${ratingMeaning(axis, level)}: ${title}`
          : `${name} is at its ${lower ? "lowest" : "highest"}, ${ratingMeaning(axis, current)}: ${title}`}
      </span>
    </CorrectionButton>
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

function Scale({ axis, current }: { axis: RatingAxis; current: number }) {
  const { name } = ratingScale[axis];
  const meaning = ratingMeaning(axis, current);
  return (
    <div className="flex w-full flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <div role="group" aria-label={`Correct ${name}`} className="flex shrink-0 items-center gap-1">
        <span aria-hidden="true" className={`w-18 ${label} text-muted-foreground`}>
          {name}
        </span>
        {levels.map((level) => (
          <CorrectionButton
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
            <span className="sr-only">{`Set ${name} to ${String(level)} of 5, ${ratingMeaning(axis, level)}`}</span>
          </CorrectionButton>
        ))}
      </div>
      {/* Lines up under the buttons on a phone. One text node for a screen reader, as on the chips. */}
      <p className={`pl-19 ${label} text-muted-foreground first-letter:uppercase sm:pl-0`}>
        <span className="sr-only">{`${name}: ${meaning}`}</span>
        <span aria-hidden="true">{meaning}</span>
      </p>
    </div>
  );
}

function Choice({ axis }: { axis: RatingAxis }) {
  return (
    // Under its label on a phone, because a meaning needs all the width there is.
    <label className={`flex w-full flex-col gap-1 ${label} text-muted-foreground sm:flex-row sm:items-center`}>
      <span className="w-18 shrink-0">{ratingScale[axis].name}</span>
      {/* Empty is where it starts, not a mistake, and the browser still refuses to submit it. */}
      <select
        name={axis}
        required
        aria-invalid={false}
        defaultValue=""
        // A select sizes itself to its longest option, and the longest meaning is wider than a phone.
        className={`${field} min-w-0 bg-background text-foreground invalid:text-muted-foreground`}
      >
        <option value="" disabled>
          Choose
        </option>
        {levels.map((level) => (
          <option key={level} value={level}>
            {`${String(level)} of 5, ${ratingMeaning(axis, level)}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Every level's meaning, for a user who sees only the current one and shouldn't have to correct to learn another. */
function ScaleGuide() {
  return (
    <details className="w-full">
      <summary
        className={`w-fit cursor-pointer rounded-sm ${label} text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30`}
      >
        What the levels mean
      </summary>
      <div className="mt-2 flex flex-col gap-3">
        {Object.values(ratingScale).map(({ name, about, levels: scale }) => (
          <div key={name} className="flex flex-col gap-1">
            <p className={`${label} text-muted-foreground`}>{`${name}, ${about}`}</p>
            <ul className="flex flex-col gap-1 text-sm">
              {scale.map(({ level, meaning }) => (
                <li key={level} className="flex gap-2">
                  <span className="font-mono">{level}</span>
                  <span className="first-letter:uppercase">{meaning}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
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
      <ScaleGuide />
    </form>
  );
}
