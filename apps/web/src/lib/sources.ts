// A Workspace's Sources, as the Sources page reads and changes them. Every query is scoped to the
// Workspace, so another Workspace's Source id behaves like a missing one.
import {
  type Config,
  type createEgressFetch,
  EgressBlockedError,
  EgressLimitError,
  encryptSecret,
  FeedHttpError,
  fetchFeed,
  fetchReleases,
  MissingRepoError,
  NotAFeedError,
  parseRepo,
  parseWithin,
  regexError,
  regionError,
  signInToken,
} from "@watchdog/core";
import { and, type Db, eq, source } from "@watchdog/db";
import { isUuid } from "./uuid.ts";

export interface SourceDeps {
  /** The egress guard's fetch: a feed URL is user input. */
  fetch: ReturnType<typeof createEgressFetch>;
  mode: Config["mode"];
  /** Encrypts a pasted GitHub token. It never leaves the server. */
  encryptionKey: Buffer;
}

/** The kinds of Source the form adds. */
export const addTypes = ["rss", "website", "github-releases", "github-issues", "github-mentions"] as const;
export type AddType = (typeof addTypes)[number];

/**
 * What the form posts, apart from a pasted token. Each type reads its own fields: `url` for RSS,
 * `url`, `region`, `ignore` and `ignoreRobots` for a website, `repo` for GitHub releases and issues,
 * `term` and `within` for GitHub mentions.
 */
export interface AddValues {
  type: AddType;
  url: string;
  repo: string;
  term: string;
  within: string;
  /** A website's Region selector, empty for the whole page. */
  region: string;
  /** A website's ignore patterns, one a line. */
  ignore: string;
  /** "on" when a self-hosted website Source skips robots.txt. */
  ignoreRobots: string;
  name: string;
  schedule: string;
}

/**
 * The form's values from a posted form or the URL it was sent back to, read by field name. A pasted
 * token is never one of them, so the URL a problem sends the form back to can't carry it.
 */
export function addValues(field: (name: string) => string): AddValues {
  return {
    type: addTypes.find((type) => type === field("type")) ?? "rss",
    url: field("url"),
    repo: field("repo"),
    term: field("term"),
    within: field("within"),
    region: field("region"),
    ignore: field("ignore"),
    ignoreRobots: field("ignoreRobots") === "on" ? "on" : "",
    name: field("name"),
    schedule: field("schedule"),
  };
}

/**
 * Why a Source wasn't saved. A code rather than a sentence, so the form can carry it in its URL
 * without letting a crafted link put words on the page.
 */
export const addProblems = [
  "invalid-url",
  "invalid-region",
  "invalid-ignore",
  "invalid-repo",
  "no-repo",
  "invalid-term",
  "invalid-within",
  "invalid-token",
  "no-token",
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

/** Adds a Source of the type the form chose. */
export function addFormSource(db: Db, deps: SourceDeps, workspaceId: string, values: AddValues & { token: string }) {
  switch (values.type) {
    case "rss":
      return addRssSource(db, deps, workspaceId, values);
    case "website":
      return addWebsiteSource(db, deps, workspaceId, values);
    case "github-releases":
      return addGithubReleasesSource(db, deps, workspaceId, values);
    case "github-issues":
      return addGithubIssuesSource(db, deps, workspaceId, values);
    case "github-mentions":
      return addGithubMentionsSource(db, deps, workspaceId, values);
  }
}

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
  const url = webUrl(input.url);
  if (url === null) return { problem: "invalid-url" };
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
 * Saves a website Source for its static fetch. The page isn't fetched first: its first poll stores the
 * Baseline, and a page it can't read shows as that poll's last error. Robots.txt can be turned off
 * only on self-hosted (ADR 0015).
 */
export async function addWebsiteSource(
  db: Db,
  deps: SourceDeps,
  workspaceId: string,
  input: { url: string; region: string; ignore: string; ignoreRobots: string; name: string; schedule: string },
): Promise<AddSourceResult> {
  const url = webUrl(input.url);
  if (url === null) return { problem: "invalid-url" };
  const region = cleanRegion(input.region);
  if (region !== "" && regionError(region) !== undefined) return { problem: "invalid-region" };
  const ignore = ignoreLines(input.ignore);
  if (ignore.length > maxIgnore || ignore.some((pattern) => regexError(pattern) !== undefined)) {
    return { problem: "invalid-ignore" };
  }
  const schedule = presetSchedule(input.schedule);
  if (schedule === undefined) return { problem: "schedule" };
  if ((await watchedName(db, workspaceId, "website", `${url.href} ${region}`)) !== undefined) {
    return { problem: "duplicate" };
  }
  const config = {
    url: url.href,
    ...(region !== "" && { region }),
    ignore,
    render: "static" as const,
    ...(deps.mode === "self-hosted" && input.ignoreRobots === "on" && { ignoreRobots: true as const }),
  };
  const name = cleanName(input.name) || cleanName(`${url.hostname}${url.pathname === "/" ? "" : url.pathname}`);
  return save(db, { workspaceId, type: "website", name, config, schedule });
}

/** At most this many ignore patterns a Source (docs: Sources and ingestion, "Website change detection"). */
const maxIgnore = 20;
const cleanRegion = (region: string) => region.replaceAll("\0", "").trim();
/** One pattern a line, trimmed, blank lines dropped. */
const ignoreLines = (ignore: string) =>
  ignore
    .replaceAll("\0", "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** An absolute http or https URL, or null. */
function webUrl(posted: string) {
  const url = URL.parse(posted.trim());
  return url !== null && (url.protocol === "http:" || url.protocol === "https:") ? url : null;
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
  if ((await watchedName(db, workspaceId, "github", githubKey({ kind: "releases", repo }))) !== undefined) {
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

/**
 * Saves a GitHub issues Source. It reads the API with the pasted token, or else the Workspace owner's
 * GitHub sign-in token, and is refused when there's neither. Like every Source, it is due at once.
 */
export async function addGithubIssuesSource(
  db: Db,
  deps: SourceDeps,
  workspaceId: string,
  input: { repo: string; token: string; name: string; schedule: string },
): Promise<AddSourceResult> {
  const repo = parseRepo(input.repo);
  if (repo === null) return { problem: "invalid-repo" };
  const config = { kind: "issues" as const, repo };
  const name = cleanName(input.name) || `${repo} issues`;
  return saveWithToken(db, deps, workspaceId, { ...input, config, name });
}

/** Saves a GitHub mentions Source: a search of issues and PRs, optionally in one org or repo. */
export async function addGithubMentionsSource(
  db: Db,
  deps: SourceDeps,
  workspaceId: string,
  input: { term: string; within: string; token: string; name: string; schedule: string },
): Promise<AddSourceResult> {
  const term = cleanTerm(input.term);
  if (term === "" || term.length > maxTermLength) return { problem: "invalid-term" };
  const within = parseWithin(input.within);
  if (within === null) return { problem: "invalid-within" };
  const config = { kind: "mentions" as const, term, ...(within !== undefined && { within }) };
  const defaultName = within === undefined ? `${term} on GitHub` : `${term} in ${within.replace(/^\w+:/, "")}`;
  return saveWithToken(db, deps, workspaceId, { ...input, config, name: cleanName(input.name) || defaultName });
}

/** GitHub caps a search query at 256 characters, which the term shares with its qualifiers. */
const maxTermLength = 100;
const cleanTerm = (term: string) => term.replaceAll("\0", "").replace(/\s+/g, " ").trim();

/** A pasted token as GitHub shows it: printable ASCII, no spaces. */
const tokenPattern = /^[\x21-\x7e]{1,255}$/;

async function saveWithToken(
  db: Db,
  deps: SourceDeps,
  workspaceId: string,
  input: {
    config: { kind: "issues"; repo: string } | { kind: "mentions"; term: string; within?: string };
    name: string;
    token: string;
    schedule: string;
  },
): Promise<AddSourceResult> {
  const schedule = presetSchedule(input.schedule);
  if (schedule === undefined) return { problem: "schedule" };
  const token = input.token.trim();
  if (token !== "" && !tokenPattern.test(token)) return { problem: "invalid-token" };
  if (token === "" && (await signInToken(db, workspaceId)) === undefined) return { problem: "no-token" };
  if ((await watchedName(db, workspaceId, "github", githubKey(input.config))) !== undefined) {
    return { problem: "duplicate" };
  }
  return save(db, {
    workspaceId,
    type: "github",
    name: input.name,
    config: input.config,
    schedule,
    secretCiphertext: token === "" ? null : encryptSecret(token, deps.encryptionKey),
  });
}

/** Only the form's own schedules: a posted cron expression could be anything. */
function presetSchedule(posted: string) {
  const schedule = posted.trim();
  return schedules.some((preset) => preset.cron === schedule) ? schedule : undefined;
}

/** The dedup key Postgres builds for a GitHub Source (docs: Sources and ingestion, "Uniqueness"). */
function githubKey(config: { kind: "releases" | "issues"; repo: string } | { kind: "mentions"; term: string; within?: string }) {
  return config.kind === "mentions"
    ? `mentions:${config.within ?? ""}:${config.term}`
    : `${config.kind}:${config.repo.toLowerCase()}`;
}

async function save(db: Db, values: typeof source.$inferInsert): Promise<AddSourceResult> {
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
export async function watchedSourceName(
  db: Db,
  workspaceId: string,
  values: Pick<AddValues, "type" | "url" | "repo"> & Partial<Pick<AddValues, "term" | "within" | "region">>,
) {
  if (values.type === "website") {
    const href = URL.parse(values.url.trim())?.href;
    const key = `${href ?? ""} ${cleanRegion(values.region ?? "")}`;
    return href === undefined ? undefined : watchedName(db, workspaceId, "website", key);
  }
  if (values.type === "rss") {
    const href = URL.parse(values.url.trim())?.href;
    return href === undefined ? undefined : watchedName(db, workspaceId, "rss", href);
  }
  if (values.type === "github-mentions") {
    const within = parseWithin(values.within ?? "");
    if (within === null) return undefined;
    const config = { kind: "mentions" as const, term: cleanTerm(values.term ?? ""), ...(within !== undefined && { within }) };
    return watchedName(db, workspaceId, "github", githubKey(config));
  }
  const repo = parseRepo(values.repo);
  const kind = values.type === "github-issues" ? "issues" : "releases";
  return repo === null ? undefined : watchedName(db, workspaceId, "github", githubKey({ kind, repo }));
}

async function watchedName(db: Db, workspaceId: string, type: "rss" | "website" | "github", dedupKey: string) {
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
    term = "",
    region = "",
    ignore = "",
    status,
    mode,
    source: watching,
  }: {
    type?: AddType;
    url: string;
    repo?: string;
    term?: string;
    region?: string;
    ignore?: string;
    status: string;
    mode: Config["mode"];
    source?: string | undefined;
  },
) {
  const github = type !== "rss" && type !== "website";
  // Only a repo parseRepo accepts is shown, so a crafted link can't put words on the page.
  const repo = parseRepo(typed) ?? "that repo";
  const hostname = github ? "github.com" : (URL.parse(url.trim())?.hostname ?? "");
  const host = hostname === "" ? "that address" : hostname;
  switch (problem) {
    case "invalid-url":
      return `Enter the full ${type === "website" ? "page" : "RSS feed"} URL, starting with https://.`;
    case "invalid-region": {
      // Only which rule the posted region breaks is said, never the region itself.
      const error = regionError(cleanRegion(region)) ?? "";
      if (error.includes(":has()")) return "The region can't use :has(). Select the element itself, such as #pricing .plan.";
      if (error.includes("characters")) return "Keep the region to 1,000 characters or fewer.";
      return "That isn't a CSS selector Watchdog can match. Enter one such as main or #pricing .plan, or leave it empty to watch the whole page.";
    }
    case "invalid-ignore": {
      const lines = ignoreLines(ignore);
      if (lines.length > maxIgnore) return `Enter at most ${String(maxIgnore)} ignore patterns, one a line.`;
      const line = lines.findIndex((pattern) => regexError(pattern) !== undefined) + 1;
      return `${line > 0 ? `Line ${String(line)}` : "A line"} isn't a regular expression Watchdog can run. Ignore patterns use RE2 syntax, such as \\d+ visitors.`;
    }
    case "invalid-repo":
      return "Enter a GitHub repo as owner/name, such as vercel/next.js, or paste its URL.";
    case "no-repo":
      return `GitHub has no public repo ${repo}. Check the name: only a public repo's releases can be watched.`;
    case "invalid-term":
      return `Enter what to search GitHub for, at most ${String(maxTermLength)} characters.`;
    case "invalid-within":
      return "Enter an org as its name, such as vercel, or a repo as owner/name, or leave it empty to search all of public GitHub.";
    case "invalid-token":
      return "Paste the token as GitHub showed it, without spaces.";
    case "no-token":
      return "Paste a fine-grained personal access token: this Workspace has no GitHub sign-in to read GitHub's API with.";
    case "schedule":
      return "Choose one of the schedules in the list.";
    case "duplicate": {
      // The term is only quoted back once it is a term the form would accept.
      const search = cleanTerm(term);
      const shownTerm = search !== "" && search.length <= maxTermLength ? `“${search}”` : "that term";
      const what = {
        rss: "watches that feed",
        website: cleanRegion(region) === "" ? "watches that page" : "watches that part of that page",
        "github-releases": `watches the releases of ${repo}`,
        "github-issues": `watches the issues of ${repo}`,
        "github-mentions": `searches GitHub for ${shownTerm}`,
      }[type];
      return watching === undefined
        ? `This Workspace already ${what}.`
        : `This Workspace already ${what} as the Source “${watching}”.`;
    }
    case "blocked":
      return `${host} leads to a private, local or non-web address, which Watchdog doesn't fetch.${mode === "self-hosted" ? " Whoever runs this Watchdog can allow a private address with EGRESS_ALLOWLIST." : ""}`;
    case "unreachable":
      return `Watchdog couldn't reach ${host}. ${github ? "Try again in a moment." : "Check the URL and try again."}`;
    case "answered": {
      const answer = /^\d{3}$/.test(status) ? `HTTP ${status}` : "with an error";
      return github
        ? `GitHub answered ${answer} instead of the releases feed of ${repo}.`
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
  if (problem === "no-token" || problem === "invalid-token") return "token";
  if (problem === "invalid-within") return "within";
  if (problem === "invalid-region") return "region";
  if (problem === "invalid-ignore") return "ignore";
  if (type === "github-mentions") return "term";
  return type === "rss" || type === "website" ? "url" : "repo";
};

/** The Workspace's Sources, newest first. */
export function listSources(db: Db, workspaceId: string) {
  return db.query.source.findMany({
    where: eq(source.workspaceId, workspaceId),
    columns: {
      id: true,
      type: true,
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
