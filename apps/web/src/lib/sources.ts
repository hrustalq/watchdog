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

/**
 * Why a feed URL wasn't saved. A code rather than a sentence, so the form can carry it in its URL
 * without letting a crafted link put words on the page.
 */
export const addProblems = [
  "invalid-url",
  "schedule",
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
 * The schedules the add form offers, the same in both modes: the form is rendered at build time,
 * before the mode is known, so it works without JavaScript. Every one meets hosted's minimum.
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
  const schedule = input.schedule.trim();
  if (scheduleError(schedule, deps.mode) !== undefined) return { problem: "schedule" };

  let feedTitle;
  try {
    const fetched = await fetchFeed(url.href, {}, deps);
    // Without a stored ETag or Last-Modified the server has nothing to answer 304 to.
    feedTitle = "feedTitle" in fetched ? fetched.feedTitle : null;
  } catch (error) {
    return fetchProblem(error);
  }

  const given = input.name.trim();
  const name = given === "" ? (feedTitle ?? url.hostname) : given;
  const [saved] = await db
    .insert(source)
    .values({ workspaceId, type: "rss", name, config: { url: url.href }, schedule })
    .returning({ id: source.id });
  if (saved === undefined) throw new Error("Inserting the Source returned no row");
  return { source: saved };
}

function fetchProblem(error: unknown): { problem: AddProblem; status?: string } {
  // Without an address, the guard refused a redirect to a URL that isn't http or https.
  if (error instanceof EgressBlockedError) {
    return { problem: error.address === undefined ? "failed" : "blocked" };
  }
  if (error instanceof EgressLimitError) return { problem: "limit" };
  // fetch's TypeError means no answer at all: DNS, a refused connection, TLS.
  if (error instanceof TypeError) return { problem: "unreachable" };
  const message = error instanceof Error ? error.message : "";
  if (message.endsWith("is not an RSS or Atom feed")) return { problem: "not-a-feed" };
  const status = / answered (\d{3})\b/.exec(message)?.[1];
  if (status !== undefined) return { problem: "answered", status };
  return { problem: "failed" };
}

/** What the form says about a problem, naming the host of the URL it was given. */
export function problemMessage(
  problem: AddProblem,
  { url, schedule, status, mode }: { url: string; schedule: string; status: string; mode: Config["mode"] },
) {
  const hostname = URL.parse(url.trim())?.hostname ?? "";
  const host = hostname === "" ? "that address" : hostname;
  switch (problem) {
    case "invalid-url":
      return "Enter the full RSS feed URL, starting with https://.";
    case "schedule":
      return scheduleError(schedule, mode) ?? "Choose one of the schedules in the list.";
    case "blocked":
      return `${host} resolves to a private or local address, which Watchdog doesn't fetch.${mode === "self-hosted" ? " Whoever runs this Watchdog can allow it with EGRESS_ALLOWLIST." : ""}`;
    case "unreachable":
      return `Watchdog couldn't reach ${host}. Check the URL and try again.`;
    case "answered":
      return `${host} answered ${/^\d{3}$/.test(status) ? `HTTP ${status}` : "with an error"} instead of a feed. Check the URL.`;
    case "not-a-feed":
      return "That page isn't an RSS or Atom feed. Use the URL of the feed itself.";
    case "limit":
      return `${host} took longer than 30 seconds or sent more than 10 MB, so Watchdog stopped reading it.`;
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
