// How an Item's Rating and Categories read, in the Feed and on the Item (DESIGN.md, "Severity chip").

const chip = "inline-flex items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs font-medium tracking-[0.01em]";

/** High is 4–5, the levels the scale says to act on this week or sooner. */
function severityLook(severity: number) {
  if (severity >= 4) return { tone: "bg-alarm/15 text-alarm", lamp: "bg-alarm" };
  if (severity === 3) return { tone: "bg-caution/15 text-caution", lamp: "bg-caution" };
  return { tone: "text-muted-foreground", lamp: "border border-muted-foreground" };
}

function Level({ value }: { value: number }) {
  return (
    <span>
      <span className="font-mono">{value}</span>
      <span className="sr-only"> of 5</span>
    </span>
  );
}

/**
 * Both axes, each named in words with its level, so neither depends on colour. Only Severity gets a
 * signal colour: Importance says what matters to the user, not that something is wrong.
 */
export function Rating({ severity, importance }: { severity: number | null; importance: number | null }) {
  if (severity === null || importance === null) {
    // No number and no lamp, because a hollow lamp is low Severity.
    return <span className={`${chip} border border-dashed text-muted-foreground`}>Unrated</span>;
  }
  const { tone, lamp } = severityLook(severity);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={`${chip} ${tone}`}>
        <span aria-hidden="true" className={`size-1.5 rounded-full ${lamp}`} />
        Severity <Level value={severity} />
      </span>
      <span className={`${chip} ${importance >= 4 ? "bg-muted text-foreground" : "text-muted-foreground"}`}>
        Importance <Level value={importance} />
      </span>
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
