// How an Item's Rating and Categories read, in the Feed and on the Item (DESIGN.md, "Rating chips").

const chip = "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-xs font-medium tracking-[0.01em]";

// Forced colours drop backgrounds, which would hide a filled lamp and leave only the hollow ones.
const filledLamp = "forced-color-adjust-none forced-colors:bg-[CanvasText]";

/** High is 4–5, the levels the scale says to act on this week or sooner. */
function severityLook(severity: number) {
  if (severity >= 4) return { tone: "border-transparent bg-alarm/10 text-alarm", lamp: `bg-alarm ${filledLamp}` };
  if (severity === 3) {
    return { tone: "border-transparent bg-caution/10 text-caution", lamp: `bg-caution ${filledLamp}` };
  }
  return { tone: "border-transparent text-muted-foreground", lamp: "border border-muted-foreground" };
}

/**
 * The "/5" shows which way the scale runs: without it, "Severity 1" can read as the worst. A screen
 * reader gets one text node, since Chrome drops a space between inline spans ("Severity5 of 5").
 */
function Reading({ axis, value }: { axis: string; value: number }) {
  return (
    <>
      <span className="sr-only">{`${axis} ${String(value)} of 5`}</span>
      <span aria-hidden="true">
        {axis} <span className="font-mono">{value}/5</span>
      </span>
    </>
  );
}

export function SeverityChip({ id, value }: { id?: string; value: number }) {
  const { tone, lamp } = severityLook(value);
  return (
    <span id={id} className={`${chip} ${tone}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${lamp}`} />
      <Reading axis="Severity" value={value} />
    </span>
  );
}

export function ImportanceChip({ id, value }: { id?: string; value: number }) {
  return (
    <span id={id} className={`${chip} border-transparent ${value >= 4 ? "text-foreground" : "text-muted-foreground"}`}>
      <Reading axis="Importance" value={value} />
    </span>
  );
}

/**
 * Both axes, each named in words with its level, so neither depends on colour. Only Severity gets a
 * signal colour: Importance says what matters to the user, not that something is wrong.
 */
export function Rating({
  id,
  severity,
  importance,
}: {
  /** For a row's link to name this as its description. */
  id?: string;
  severity: number | null;
  importance: number | null;
}) {
  if (severity === null || importance === null) {
    // No number and no lamp, because a hollow lamp is low Severity.
    return (
      <span id={id} className={`${chip} border-dashed text-muted-foreground`}>
        Unrated
      </span>
    );
  }
  return (
    <span id={id} className="inline-flex flex-wrap items-center gap-1.5">
      <SeverityChip value={severity} />
      <ImportanceChip value={importance} />
    </span>
  );
}

export function CategoryList({ categories }: { categories: string[] }) {
  if (categories.length === 0) return null;
  return (
    <ul aria-label="Categories" className="flex min-w-0 flex-wrap items-center gap-1.5">
      {categories.map((category) => (
        <li key={category} className="min-w-0 rounded-sm border px-1.5 py-0.5 font-mono text-xs break-all">
          {category}
        </li>
      ))}
    </ul>
  );
}
