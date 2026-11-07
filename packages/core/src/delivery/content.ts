// What an alert says, whichever Destination it goes to (docs: Actions and delivery, "Alerts").

/** Item text is untrusted, so each sender has to send these values as text or escape them. */
export interface AlertMessage {
  title: string;
  source: string;
  /** The Rating in words, or "unrated". */
  rating: string;
  severity: number | null;
  summary: string | null;
  /** The Item in Watchdog, which an Item without a URL has too. */
  link: string;
  /** The Condition the Item met, in words. */
  why: string;
}

/**
 * What a webhook's body says, apart from its version. The Item envelope leaves out `raw`, which can be large
 * and is the Source's data.
 */
export interface WebhookMessage {
  action: string;
  item: {
    id: string;
    sourceId: string;
    externalId: string;
    url: string | null;
    title: string | null;
    author: string | null;
    body: string;
    publishedAt: Date | null;
    capturedAt: Date;
    language: string | null;
    isBackfill: boolean;
    summary: string | null;
  };
  rating: { severity: number; importance: number } | null;
  categories: string[];
  fields: Record<string, unknown>;
  /** The Condition the Item met, in words. */
  firedBecause: string;
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
  return { ...itemHeadline(item, appUrl), severity: item.severity, source, summary: item.summary, why };
}
