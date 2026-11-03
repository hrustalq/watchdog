// A Workspace's Sources, as the Sources page reads and changes them. Every query is scoped to the
// Workspace, so another Workspace's Source id behaves like a missing one.
import {
  type Config,
  type createEgressFetch,
  EgressBlockedError,
  EgressLimitError,
  fetchFeed,
  scheduleError,
} from "@watchdog/core";
import { and, type Db, eq, source } from "@watchdog/db";

export interface SourceDeps {
  /** The egress guard's fetch: a feed URL is user input. */
  fetch: ReturnType<typeof createEgressFetch>;
  mode: Config["mode"];
}

export interface AddSourceInput {
  url: string;
  name: string;
  schedule: string;
}

export type AddSourceResult =
  | { source: { id: string; name: string } }
  | { field: "url" | "schedule"; error: string };

/** The schedules the add form offers. Self-hosted's minimum is 5 minutes, hosted's 15. */
export function schedulePresets(mode: Config["mode"]) {
  return [
    ...(mode === "self-hosted" ? [{ cron: "*/5 * * * *", label: "Every 5 minutes" }] : []),
    { cron: "*/15 * * * *", label: "Every 15 minutes" },
    { cron: "0 * * * *", label: "Every hour" },
    { cron: "0 0 * * *", label: "Every day" },
  ];
}

/**
 * Fetches and parses the feed once, and saves it as an RSS Source only if that worked. The new
 * Source is due at once, so the worker's next tick polls it and takes the Backfill.
 */
export async function addRssSource(
  db: Db,
  deps: SourceDeps,
  workspaceId: string,
  input: AddSourceInput,
): Promise<AddSourceResult> {
  const url = URL.parse(input.url.trim());
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { field: "url", error: "Enter the full RSS feed URL, starting with https://." };
  }
  const schedule = input.schedule.trim();
  const refused = scheduleError(schedule, deps.mode);
  if (refused !== undefined) return { field: "schedule", error: refused };

  let feedTitle;
  try {
    const fetched = await fetchFeed(url.href, {}, deps);
    // Without a stored ETag or Last-Modified the server has nothing to answer 304 to.
    feedTitle = "feedTitle" in fetched ? fetched.feedTitle : null;
  } catch (error) {
    return { field: "url", error: fetchError(error, url, deps.mode) };
  }

  const given = input.name.trim();
  const name = given === "" ? (feedTitle ?? url.hostname) : given;
  const [saved] = await db
    .insert(source)
    .values({ workspaceId, type: "rss", name, config: { url: url.href }, schedule })
    .returning({ id: source.id, name: source.name });
  if (saved === undefined) throw new Error("Inserting the Source returned no row");
  return { source: saved };
}

function fetchError(error: unknown, url: URL, mode: Config["mode"]) {
  if (error instanceof EgressBlockedError) {
    if (error.address === undefined) return `${error.message}.`;
    const allowlist = mode === "self-hosted" ? " Whoever runs it can allow one with EGRESS_ALLOWLIST." : "";
    return `${error.host} resolves to ${error.address}, a private or local address, which Watchdog doesn't fetch.${allowlist}`;
  }
  if (error instanceof EgressLimitError) return `${error.message}.`;
  // fetch's TypeError means no answer at all: DNS, a refused connection, TLS.
  if (error instanceof TypeError) {
    return `Watchdog couldn't reach ${url.hostname}. Check the URL and try again.`;
  }
  if (error instanceof Error && error.message.endsWith("is not an RSS or Atom feed")) {
    return "That page isn't an RSS or Atom feed. Use the URL of the feed itself.";
  }
  // fetchFeed's own messages, such as "<url> answered 404 Not Found", are written for the user.
  return error instanceof Error ? `${error.message}.` : String(error);
}

/** The Workspace's Sources, newest first. */
export function listSources(db: Db, workspaceId: string) {
  return db.query.source.findMany({
    where: eq(source.workspaceId, workspaceId),
    columns: {
      id: true,
      name: true,
      config: true,
      schedule: true,
      lastPolledAt: true,
      lastError: true,
      lastErrorAt: true,
    },
    orderBy: (table, { desc }) => [desc(table.createdAt), desc(table.id)],
  });
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deletes the Source, and with it its Items and their Logs (both cascade). Returns false when the
 * Workspace has no Source with this id, which includes another Workspace's.
 */
export async function removeSource(db: Db, workspaceId: string, sourceId: string) {
  // Postgres refuses a malformed uuid with an error rather than matching nothing.
  if (!uuid.test(sourceId)) return false;
  const removed = await db
    .delete(source)
    .where(and(eq(source.workspaceId, workspaceId), eq(source.id, sourceId)))
    .returning({ id: source.id });
  return removed.length > 0;
}
