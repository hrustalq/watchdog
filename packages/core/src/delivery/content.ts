// What an alert says, whichever Destination it goes to (docs: Actions and delivery, "Alerts").

/** Item text is untrusted, so each sender has to send these values as text or escape them. */
export interface AlertMessage {
  title: string;
  source: string;
  /** The Rating in words, or "unrated". */
  rating: string;
  summary: string | null;
  /** The Item in Watchdog, which an Item without a URL has too. */
  link: string;
  /** The Condition the Item met, in words. */
  why: string;
}

export interface AlertItem {
  id: string;
  title: string | null;
  summary: string | null;
  severity: number | null;
  importance: number | null;
}

export function itemHeadline(item: Omit<AlertItem, "summary">, appUrl: string) {
  const { severity, importance } = item;
  return {
    title: item.title ?? "Untitled Item",
    rating:
      severity === null || importance === null
        ? "unrated"
        : `Severity ${String(severity)}, Importance ${String(importance)}`,
    link: new URL(`/items/${item.id}`, appUrl).href,
  };
}

export function alertContent(item: AlertItem, source: string, why: string, appUrl: string): AlertMessage {
  return { ...itemHeadline(item, appUrl), source, summary: item.summary, why };
}
