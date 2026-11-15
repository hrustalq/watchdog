import { filledLamp } from "@/components/rating";
import { cn } from "@/lib/utils";

const lamps = {
  /** A failure or an error: the lamp and the words are Alarm Red. */
  alarm: { text: "text-alarm", lamp: `bg-alarm ${filledLamp}` },
  /** Something to fix that isn't broken, such as a Rule that can't run yet: the words stay ink. */
  caution: { text: "text-foreground", lamp: `bg-caution ${filledLamp}` },
} as const;

/**
 * A line that reports something: a 6px lamp, then the words, aligned to the first line rather than
 * the top of a wrapped block. The lamp is a shape as well as a colour, and it is drawn in
 * `CanvasText` in forced colors, so the line still reads with colour taken away. `alarm` makes the
 * words red because something failed; `caution` keeps them ink because something merely needs
 * attention, and red there would claim a failure that hasn't happened.
 */
export function SignalLine({
  tone,
  as: Line = "p",
  className,
  children,
}: {
  tone: keyof typeof lamps;
  /** `span` when the line sits inside a Notice, whose own element is already the paragraph. */
  as?: "p" | "span";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Line className={cn("flex items-baseline gap-2 text-sm", lamps[tone].text, className)}>
      <span aria-hidden="true" className={cn("size-1.5 shrink-0 translate-y-[-1px] rounded-full", lamps[tone].lamp)} />
      <span className="min-w-0 break-words">{children}</span>
    </Line>
  );
}
