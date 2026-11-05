import { X } from "lucide-react";
import { field } from "@/components/field-classes";
import { Button } from "@/components/ui/button";
import { correctCategoriesAction } from "../../actions";
import { CorrectionStatus } from "../../correction-status";
import { SubmitButton } from "../../sign-in/submit-button";

/**
 * The Item's Categories, each with its remove button, and a box to add one. Two forms, because Enter in
 * the box would otherwise press the first remove button.
 */
export function CorrectCategories({ itemId, categories }: { itemId: string; categories: string[] }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <form action={correctCategoriesAction} className="has-data-pending:opacity-60">
        <input type="hidden" name="itemId" value={itemId} />
        <CorrectionStatus />
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
                <Button type="submit" name="remove" value={category} variant="ghost" size="icon-xs">
                  <X aria-hidden="true" />
                  <span className="sr-only">Remove the Category {category}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </form>
      <form action={correctCategoriesAction} className="flex items-center gap-2 has-data-pending:opacity-60">
        <input type="hidden" name="itemId" value={itemId} />
        <CorrectionStatus />
        <input
          type="text"
          name="add"
          required
          maxLength={100}
          autoComplete="off"
          aria-label="Add a Category"
          placeholder="Add a Category"
          className={`${field} w-48`}
        />
        <SubmitButton variant="outline" pendingLabel="Adding…" className="w-auto">
          Add
        </SubmitButton>
      </form>
    </div>
  );
}
