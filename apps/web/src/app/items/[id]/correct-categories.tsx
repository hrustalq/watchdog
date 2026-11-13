import { X } from "lucide-react";
import { field } from "@/components/field-classes";
import { maxCategoryLength } from "@/lib/corrections";
import { correctCategoriesAction } from "../../actions";
import { CorrectionButton, CorrectionStatus } from "../../correction-status";
import { SubmitButton } from "../../sign-in/submit-button";

/** The add box's suggestions, which is the page's one list of them. */
const knownList = "item-categories";

/**
 * The Item's Categories, each with its remove button, and a box to add one. Two forms, because Enter in
 * the box would otherwise press the first remove button.
 *
 * The box offers the Workspace's known Categories through a `datalist`, which the browser draws itself,
 * so the suggestions are in the HTML and work with JavaScript off. A Category is open-ended, so what
 * isn't offered can still be typed.
 */
export function CorrectCategories({
  itemId,
  categories,
  suggestions,
}: {
  itemId: string;
  categories: string[];
  /** The Workspace's known Categories, in the order to offer them. */
  suggestions: string[];
}) {
  const result = `Categories now: ${categories.length === 0 ? "none" : categories.join(", ")}`;
  // The Item's own are no help: it already has them, and adding one again changes nothing.
  const offered = suggestions.filter((category) => !categories.includes(category));
  return (
    <div className="flex flex-col items-start gap-2">
      <form action={correctCategoriesAction} className="has-data-pending:opacity-60">
        <input type="hidden" name="itemId" value={itemId} />
        <CorrectionStatus result={result} />
        {categories.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ul aria-label="Categories" className="flex min-w-0 flex-wrap items-center gap-1.5">
            {categories.map((category) => (
              <li
                key={category}
                className="flex min-w-0 items-center gap-0.5 rounded-sm border pl-1.5 font-mono text-xs break-all"
              >
                {category}
                <CorrectionButton type="submit" name="remove" value={category} variant="ghost" size="icon-xs">
                  <X aria-hidden="true" />
                  <span className="sr-only">Remove the Category {category}</span>
                </CorrectionButton>
              </li>
            ))}
          </ul>
        )}
      </form>
      <form action={correctCategoriesAction} className="flex items-center gap-2 has-data-pending:opacity-60">
        <input type="hidden" name="itemId" value={itemId} />
        <CorrectionStatus result={result} />
        <input
          type="text"
          name="add"
          required
          aria-invalid={false}
          maxLength={maxCategoryLength}
          pattern=".*\S.*"
          title="A Category can't be blank."
          autoComplete="off"
          list={knownList}
          aria-label="Add a Category"
          placeholder="Add a Category"
          className={`${field} w-48`}
        />
        <datalist id={knownList}>
          {offered.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
        <SubmitButton variant="outline" pendingLabel="Adding…" className="w-auto">
          Add
        </SubmitButton>
      </form>
    </div>
  );
}
