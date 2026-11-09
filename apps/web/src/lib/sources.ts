// A Workspace's Sources, as the Sources page reads and changes them. Every query is scoped to the
// Workspace, so another Workspace's Source id behaves like a missing one.
import {
  type Config,
  type createEgressFetch,
  EgressBlockedError,
  EgressLimitError,
  FeedHttpError,
  fetchFeed,
  fetchReleases,
  MissingRepoError,
  NotAFeedError,
  parseRepo,
} from "@watchdog/core";
import { and, type Db, eq, source, type SourceConfigs } from "@watchdog/db";
import { isUuid } from "./uuid.ts";

export interface SourceDeps {
  /** The egress guard's fetch: a feed URL is user input. */
  fetch: ReturnType<typeof createEgressFetch>;
  mode: Config["mode"];
}

/** The kinds of Source the form adds. */
export const addTypes = ["rss", "github-releases"] as const;
export type AddType = (typeof addTypes)[number];

/** What the form posts. Each type reads its own field: `url` for RSS, `repo` for GitHub releases. */
export interface AddValues {
  type: AddType;
  url: string;
  repo: string;
  name: string;
  schedule: string;
}

/**
 * Why a Source wasn't saved. A code rather than a sentence, so the form can carry it in its URL
 * without letting a crafted link put words on the page.
 */
export const addProblems = [
  "invalid-url",
  "invalid-repo",
  "no-repo",
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
  const schedule = presetSchedule(input.schedule);
  if (schedule === undefined) return { problem: "schedule" };
  if ((await watchedName(db, workspaceId, "rss", url.href)) !== undefined) return { problem: "duplicate" };

  let feedTitle;
  try {
    const fetched = await fetchFeed(url.href, {}, deps);
    // Without a stored ETag or Last-Modified the server has nothing to answer 304 to.
    feedTitle = "feedTitle" in fetched ? fetched.feedTitle : null;
  } catch (error) {
    return fetchProblem(error);
  }

  const name = cleanName(input.name) || cleanName(feedTitle ?? "") || url.hostname;
  return save(db, { workspaceId, type: "rss", name, config: { url: url.href }, schedule });
}

/**
 * Checks that GitHub has the repo's releases feed, and saves it as a GitHub releases Source only
 * if so. Like an RSS Source, it is due at once.
 */
export async function addGithubReleasesSource(
  db: Db,
  deps: SourceDeps,
  workspaceId: string,
  input: { repo: string; name: string; schedule: string },
): Promise<AddSourceResult> {
  const repo = parseRepo(input.repo);
  if (repo === null) return { problem: "invalid-repo" };
  const schedule = presetSchedule(input.schedule);
  if (schedule === undefined) return { problem: "schedule" };
  if ((await watchedName(db, workspaceId, "github", releasesKey(repo))) !== undefined) {
    return { problem: "duplicate" };
  }

  try {
    await fetchReleases(repo, {}, deps);
  } catch (error) {
    return error instanceof MissingRepoError ? { problem: "no-repo" } : fetchProblem(error);
  }

  const name = cleanName(input.name) || `${repo} releases`;
  return save(db, { workspaceId, type: "github", name, config: { kind: "releases", repo }, schedule });
}

/** Only the form's own schedules: a posted cron expression could be anything. */
function presetSchedule(posted: string) {
  const schedule = posted.trim();
  return schedules.some((preset) => preset.cron === schedule) ? schedule : undefined;
}

/** The dedup key Postgres builds for a GitHub releases Source (docs: Sources and ingestion, "Uniqueness"). */
const releasesKey = (repo: string) => `releases:${repo.toLowerCase()}`;

type NewSource =
  | { workspaceId: string; type: "rss"; name: string; config: SourceConfigs["rss"]; schedule: string }
  | { workspaceId: string; type: "github"; name: string; config: SourceConfigs["github"]; schedule: string };

async function save(db: Db, values: NewSource): Promise<AddSourceResult> {
  // Another add of the same Source can finish between the duplicate check and this insert, and then
  // the unique key on (workspace_id, type, dedup_key) skips this row. Its other unique keys are on a
  // random id or the Inbox token hash these types don't have, so that key is the only one an insert
  // can hit. Drizzle 0.45 takes only columns as a conflict target, which can't name an expression
  // index.
  const [saved] = await db.insert(source).values(values).onConflictDoNothing().returning({ id: source.id });
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
 * The name of the Workspace's Source that the form's values would add again, or undefined. A feed
 * URL compares as saved (`URL.href`), a repo in any case.
 */
export async function watchedSourceName(db: Db, workspaceId: string, values: Omit<AddValues, "name" | "schedule">) {
  if (values.type === "rss") {
    const href = URL.parse(values.url.trim())?.href;
    return href === undefined ? undefined : watchedName(db, workspaceId, "rss", href);
  }
  const repo = parseRepo(values.repo);
  return repo === null ? undefined : watchedName(db, workspaceId, "github", releasesKey(repo));
}

async function watchedName(db: Db, workspaceId: string, type: "rss" | "github", dedupKey: string) {
  const [watched] = await db
    .select({ name: source.name })
    .from(source)
    .where(and(eq(source.workspaceId, workspaceId), eq(source.type, type), eq(source.dedupKey, dedupKey)));
  return watched?.name;
}

/**
 * What the form says about a problem, naming the host of the URL or the repo it was given, or for
 * "duplicate" the Source that already watches it.
 */
export function problemMessage(
  problem: AddProblem,
  {
    type = "rss",
    url,
    repo: typed = "",
    status,
    mode,
    source: watching,
  }: {
    type?: AddType;
    url: string;
    repo?: string;
    status: string;
    mode: Config["mode"];
    source?: string | undefined;
  },
) {
  const github = type === "github-releases";
  // Only a repo parseRepo accepts is shown, so a crafted link can't put words on the page.
  const repo = parseRepo(typed) ?? "that repo";
  const hostname = github ? "github.com" : (URL.parse(url.trim())?.hostname ?? "");
  const host = hostname === "" ? "that address" : hostname;
  switch (problem) {
    case "invalid-url":
      return "Enter the full RSS feed URL, starting with https://.";
    case "invalid-repo":
      return "Enter a GitHub repo as owner/name, such as vercel/next.js, or paste its URL.";
    case "no-repo":
      return `GitHub has no public repo ${repo}. Check the name: only a public repo's releases can be watched.`;
    case "schedule":
      return "Choose one of the schedules in the list.";
    case "duplicate": {
      const what = github ? `the releases of ${repo}` : "that feed";
      return watching === undefined
        ? `This Workspace already watches ${what}.`
        : `This Workspace already watches ${what} as the Source “${watching}”.`;
    }
    case "blocked":
      return `${host} leads to a private, local or non-web address, which Watchdog doesn't fetch.${mode === "self-hosted" ? " Whoever runs this Watchdog can allow a private address with EGRESS_ALLOWLIST." : ""}`;
    case "unreachable":
      return `Watchdog couldn't reach ${host}. Check the URL and try again.`;
    case "answered": {
      const answer = /^\d{3}$/.test(status) ? `HTTP ${status}` : "with an error";
      return github
        ? `GitHub answered ${answer} instead of the releases feed. Try again in a moment.`
        : `${host} answered ${answer} instead of a feed. Check the URL.`;
    }
    case "not-a-feed":
      return github
        ? "GitHub didn't answer with the releases feed. Try again in a moment."
        : "That page isn't an RSS or Atom feed. Use the URL of the feed itself.";
    case "limit":
      return `${host} was too slow, sent too much or redirected too many times, so Watchdog stopped reading it.`;
    case "failed":
      return `Watchdog couldn't read a feed from ${host}. Try again in a moment.`;
  }
}

/** Which form field a problem is about. */
export const problemField = (problem: AddProblem, type: AddType = "rss") => {
  if (problem === "schedule") return "schedule";
  return type === "rss" ? "url" : "repo";
};

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
