import Link from "next/link";
import { filledLamp } from "@/components/rating";
import { modelLink } from "./rules/words";

const inlineLink =
  "rounded-sm text-foreground underline underline-offset-4 outline-hidden focus-visible:ring-3 focus-visible:ring-ring/60";

/**
 * Why new Items are staying unrated when the model itself is failing (DESIGN.md, "Alarm Red": a lamp
 * and words, never colour alone). The provider's reason stays on Model: it can be long and private.
 *
 * The region renders empty when the model is healthy and a refresh fills it in or empties it again, so
 * a screen reader hears the change without a reload. It takes no room while it's empty.
 */
export function ModelFailureNotice({ failing }: { failing: boolean }) {
  return (
    <p role="status" className="empty:hidden">
      {failing ? (
        <span className="flex items-start gap-2 text-sm text-alarm">
          <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm ${filledLamp}`} />
          <span className="min-w-0 break-words">
            The Agent can&apos;t rate Items right now, because its last call to the model failed.{" "}
            <Link href={modelLink} className={inlineLink}>
              Check the model
            </Link>
          </span>
        </span>
      ) : null}
    </p>
  );
}
