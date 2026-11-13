import Link from "next/link";
import { filledLamp } from "@/components/rating";
import { modelLink } from "./rules/words";

const inlineLink =
  "rounded-sm text-foreground underline underline-offset-4 outline-hidden focus-visible:ring-3 focus-visible:ring-ring/60";

/**
 * An Alarm Red line with a lamp and words, never colour alone (DESIGN.md). The region renders empty
 * while there's nothing to say and a refresh fills it in or empties it again, so a screen reader hears
 * the change without a reload. It takes no room while it's empty.
 */
function AlarmLine({ said }: { said: React.ReactNode | undefined }) {
  return (
    <p role="status" className="empty:hidden">
      {said === undefined ? null : (
        <span className="flex items-start gap-2 text-sm text-alarm">
          <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full bg-alarm ${filledLamp}`} />
          <span className="min-w-0 break-words">{said}</span>
        </span>
      )}
    </p>
  );
}

/**
 * Why new Items are staying unrated when the model itself is failing. The provider's reason stays on
 * Model: it can be long and private.
 */
export function ModelFailureNotice({ failing }: { failing: boolean }) {
  return (
    <AlarmLine
      said={
        failing ? (
          <>
            The Agent can&apos;t rate Items right now, because its last call to the model failed.{" "}
            <Link href={modelLink} className={inlineLink}>
              Check the model
            </Link>
          </>
        ) : undefined
      }
    />
  );
}

/**
 * Why new Items are staying unrated when the model is there but Watchdog can't read its stored API
 * key. The variable and what to do about it stay on Model, as the model's own failure does.
 */
export function UnreadableKeyNotice({ unreadable }: { unreadable: boolean }) {
  return (
    <AlarmLine
      said={
        unreadable ? (
          <>
            The Agent can&apos;t rate Items, because Watchdog can&apos;t read the model&apos;s stored API key.{" "}
            <Link href={modelLink} className={inlineLink}>
              Enter the key again
            </Link>
          </>
        ) : undefined
      }
    />
  );
}
