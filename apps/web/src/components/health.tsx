// How a Source's Health reads on the Sources screen (DESIGN.md, "Health chip").

const chip = "inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-transparent px-1.5 py-0.5 text-xs font-medium tracking-[0.01em]";

// Forced colours drop backgrounds, which would hide the lamp.
const lamp = "size-1.5 rounded-full forced-color-adjust-none forced-colors:bg-[CanvasText]";

// Healthy is the expected state, so it gets a green lamp and no tint.
const looks = {
  ok: { word: "OK", tone: "text-muted-foreground", light: "bg-ok" },
  degraded: { word: "Degraded", tone: "bg-caution/10 text-caution", light: "bg-caution" },
  failing: { word: "Failing", tone: "bg-alarm/10 text-alarm", light: "bg-alarm" },
};

/** The Health in a word, so it never depends on colour. A screen reader hears "Health: failing". */
export function HealthChip({ health }: { health: keyof typeof looks }) {
  const { word, tone, light } = looks[health];
  return (
    <span className={`${chip} ${tone}`}>
      <span aria-hidden="true" className={`${lamp} ${light}`} />
      <span className="sr-only">{`Health: ${health}`}</span>
      <span aria-hidden="true">{word}</span>
    </span>
  );
}
