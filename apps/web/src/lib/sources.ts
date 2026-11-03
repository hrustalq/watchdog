// A Workspace's Sources, as the Sources page reads and changes them. Every query is scoped to the
// Workspace, so another Workspace's Source id behaves like a missing one.
import {
  type Config,
  type createEgressFetch,
  EgressBlockedError,
  EgressLimitError,
  FeedHttpError,
  fetchFeed,
  NotAFeedError,
} from "@watchdog/core";
import { and, type Db, eq, source, sql } from "@watchdog/db";
import { isUuid } from "./uuid.ts";

export interface SourceDeps {
  /** The egress guard's fetch: a feed URL is user input. */
  fetch: ReturnType<typeof createEgressFetch>;
  mode: Config["mode"];
}

/**
 * Why a feed URL wasn't saved. A code rather than a sentence, so the form can carry it in its URL
 * without letting a crafted link put words on the page.
 */
export const addProblems = [
  "invalid-url",
  "schedule",
  "duplicate",
  "blocked",
  "unreachable",
  "answered",
  "not-a-feed",
  "limit",
  "failed",
] as const;
export type AddProblem = (typeof addProblems)[number];

export type AddSourceResult =
  | { source: { id: string } }
  /** `status` is the HTTP status for "answered". */
  | { problem: AddProblem; status?: string };

/**
 * The schedules a Source can be added with, the same in both modes: the form is rendered at build
 * time, before the mode is known, so it works without JavaScript. Every one meets hosted's minimum.
 */
export const schedules = [
  { cron: "*/15 * * * *", label: "Every 15 minutes" },
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "0 0 * * *", label: "Every day" },
];

/**
 * Fetches and parses the feed once, and saves it as an RSS Source only if that worked. The new
 * Source is due at once, so the worker's next tick polls it and takes the Backfill.
 */
export async function addRssSource(
  db: Db,
  deps: SourceDeps,
  workspaceId: string,
  input: { url: string; name: string; schedule: string },
): Promise<AddSourceResult> {
  const url = URL.parse(input.url.trim());
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { problem: "invalid-url" };
  }
  // Only the form's own schedules: a posted cron expression could be anything.
  const schedule = input.schedule.trim();
  if (!schedules.some((preset) => preset.cron === schedule)) return { problem: "schedule" };
  if ((await watchedSourceName(db, workspaceId, url.href)) !== undefined) return { problem: "duplicate" };

  let feedTitle;
  try {
    const fetched = await fetchFeed(url.href, {}, deps);
    // Without a stored ETag or Last-Modified the server has nothing to answer 304 to.
    feedTitle = "feedTitle" in fetched ? fetched.feedTitle : null;
  } catch (error) {
    return fetchProblem(error);
  }

  const name = cleanName(input.name) || cleanName(feedTitle ?? "") || url.hostname;
  // Another add of the same URL can finish between the check above and this insert. The unique
  // key on (workspace_id, url) is the only one an insert can hit, so a skipped row is that add.
  const [saved] = await db
    .insert(source)
    .values({ workspaceId, type: "rss", name, config: { url: url.href }, schedule })
    .onConflictDoNothing()
    .returning({ id: source.id });
  return saved === undefined ? { problem: "duplicate" } : { source: saved };
}

/** A name on one line, at most 200 characters, without the NUL Postgres text refuses. */
const cleanName = (name: string) => name.replaceAll("\0", "").replace(/\s+/g, " ").trim().slice(0, 200);

function fetchProblem(error: unknown): { problem: AddProblem; status?: string } {
  // Also a redirect to a blocked address, or to a URL that isn't http or https.
  if (error instanceof EgressBlockedError) return { problem: "blocked" };
  // A timeout, a response over the size cap, or too many redirects.
  if (error instanceof EgressLimitError) return { problem: "limit" };
  // fetch's TypeError means no answer at all: DNS, a refused connection, TLS.
  if (error instanceof TypeError) return { problem: "unreachable" };
  if (error instanceof NotAFeedError) return { problem: "not-a-feed" };
  if (error instanceof FeedHttpError) return { problem: "answered", status: String(error.status) };
  return { problem: "failed" };
}

/**
 * The name of the Workspace's Source that watches this feed URL, compared as saved (`URL.href`), or
 * undefined.
 */
export async function watchedSourceName(db: Db, workspaceId: string, url: string) {
  const href = URL.parse(url.trim())?.href;
  if (href === undefined) return undefined;
  const [watched] = await db
    .select({ name: source.name })
    .from(source)
    .where(and(eq(source.workspaceId, workspaceId), sql`${source.config}->>'url' = ${href}`));
  return watched?.name;
}

/**
 * What the form says about a problem, naming the host of the URL it was given, or for "duplicate"
 * the Source that already watches it.
 */
export function problemMessage(
  problem: AddProblem,
  {
    url,
    status,
    mode,
    source: watching,
  }: { url: string; status: string; mode: Config["mode"]; source?: string | undefined },
) {
  const hostname = URL.parse(url.trim())?.hostname ?? "";
  const host = hostname === "" ? "that address" : hostname;
  switch (problem) {
    case "invalid-url":
      return "Enter the full RSS feed URL, starting with https://.";
    case "schedule":
      return "Choose one of the schedules in the list.";
    case "duplicate":
      return watching === undefined
        ? "This Workspace already watches that feed."
        : `This Workspace already watches that feed as the Source “${watching}”.`;
    case "blocked":
      return `${host} leads to a private, local or non-web address, which Watchdog doesn't fetch.${mode === "self-hosted" ? " Whoever runs this Watchdog can allow a private address with EGRESS_ALLOWLIST." : ""}`;
    case "unreachable":
      return `Watchdog couldn't reach ${host}. Check the URL and try again.`;
    case "answered":
      return `${host} answered ${/^\d{3}$/.test(status) ? `HTTP ${status}` : "with an error"} instead of a feed. Check the URL.`;
    case "not-a-feed":
      return "That page isn't an RSS or Atom feed. Use the URL of the feed itself.";
    case "limit":
      return `${host} was too slow, sent too much or redirected too many times, so Watchdog stopped reading it.`;
    case "failed":
      return `Watchdog couldn't read a feed from ${host}. Try again in a moment.`;
  }
}

/** Which form field a problem is about. */
export const problemField = (problem: AddProblem) => (problem === "schedule" ? "schedule" : "url");

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

/**
 * Deletes the Source, and with it its Items and their Logs (both cascade). Returns false when the
 * Workspace has no Source with this id, which includes another Workspace's.
 */
export async function removeSource(db: Db, workspaceId: string, sourceId: string) {
  if (!isUuid(sourceId)) return false;
  const removed = await db
    .delete(source)
    .where(and(eq(source.workspaceId, workspaceId), eq(source.id, sourceId)))
    .returning({ id: source.id });
  return removed.length > 0;
}
