// robots.txt, read before each fetch of a website Source's page (docs: Sources and ingestion,
// "Website change detection"; ADR 0015), under RFC 9309.
import type { createEgressFetch } from "../../egress/egress.ts";

/** The User-Agent product token robots.txt groups name Watchdog by. */
const token = "watchdog";
const day = 24 * 60 * 60 * 1000;
/** RFC 9309 lets a crawler stop parsing after 500 KiB. */
const maxParsedBytes = 500 * 1024;

interface Rule {
  allow: boolean;
  pattern: string;
}

/** Each origin's rules for Watchdog (none when robots.txt allows everything), kept for a day. */
const cache = new Map<string, { rules: Rule[]; until: number }>();

/**
 * Throws, naming robots.txt, when the page's origin disallows Watchdog from fetching it. A stopped
 * poll's signal ends the fetch with it, and the rules it never read aren't kept.
 */
export async function checkRobots(
  pageUrl: string,
  deps: { fetch: ReturnType<typeof createEgressFetch>; now: Date; signal?: AbortSignal },
) {
  const page = new URL(pageUrl);
  const url = `${page.origin}/robots.txt`;
  const now = deps.now.getTime();
  let cached = cache.get(page.origin);
  if (cached === undefined || cached.until <= now) {
    for (const [origin, entry] of cache) if (entry.until <= now) cache.delete(origin);
    cached = { rules: await fetchRules(url, deps), until: now + day };
    cache.set(page.origin, cached);
  }
  if (!allows(cached.rules, encoded(page.pathname + page.search))) {
    throw new Error(`${url} disallows Watchdog from fetching this page`);
  }
}

/**
 * A robots.txt that answers 4xx allows everything. One that answers 429 or 5xx, or can't be fetched,
 * disallows this poll and isn't kept, so the next poll asks again. A fetch stopped with the worker
 * throws as it is, so the poll fails for a retry instead of this Source's page going unfetched.
 */
async function fetchRules(
  url: string,
  deps: { fetch: ReturnType<typeof createEgressFetch>; signal?: AbortSignal },
) {
  const unavailable = (why: string) => `${url} ${why}, so Watchdog didn't fetch the page. The next poll tries again.`;
  let response;
  try {
    response = await deps.fetch(url, deps.signal && { signal: deps.signal });
  } catch (error) {
    if (deps.signal?.aborted === true) throw error;
    // fetch's TypeError says only "fetch failed"; its cause says why.
    const reason = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new Error(unavailable(`couldn't be read (${reason instanceof Error ? reason.message : String(reason)})`), {
      cause: error,
    });
  }
  if (response.ok) return rulesFor(new TextDecoder().decode((await response.bytes()).subarray(0, maxParsedBytes)));
  await response.body?.cancel();
  // 429 asks Watchdog to slow down, so it is as unavailable as a 5xx.
  if (response.status >= 400 && response.status < 500 && response.status !== 429) return [];
  throw new Error(unavailable(`answered ${String(response.status)}`));
}

/** The rules of every group naming Watchdog, or else of every `*` group. */
export function rulesFor(robotsTxt: string): Rule[] {
  const groups = new Map<string, Rule[]>();
  let agents: string[] = [];
  let inRules = false;
  for (const line of robotsTxt.split(/\r\n|\r|\n/)) {
    const match = /^\s*([a-z-]+)\s*:\s*([^#]*)/i.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (key === "user-agent") {
      // A user-agent line after rules starts a new group.
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      // A group with no rules still applies: an empty `Disallow:` for Watchdog allows it everything.
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), []);
    } else if (key === "allow" || key === "disallow") {
      inRules = true;
      // An empty disallow disallows nothing.
      if (value === "") continue;
      for (const agent of agents) {
        const rules = groups.get(agent) ?? [];
        rules.push({ allow: key === "allow", pattern: encoded(value) });
        groups.set(agent, rules);
      }
    }
  }
  return groups.get(token) ?? groups.get("*") ?? [];
}

/** The longest matching rule decides, and allow wins a tie. robots.txt itself is always allowed. */
export function allows(rules: Rule[], path: string) {
  if (path === "/robots.txt") return true;
  let decided: Rule | undefined;
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    const length = decided?.pattern.length ?? -1;
    if (rule.pattern.length > length || (rule.pattern.length === length && rule.allow)) decided = rule;
  }
  return decided?.allow ?? true;
}

/**
 * Whether a pattern matches the start of the path: `*` matches any run of characters and a final `$`
 * the end. It tracks every position the pattern can have reached, as Google's parser does, so a
 * hostile pattern costs at most its length times the path's.
 */
function matches(pattern: string, path: string) {
  let ends = [0];
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "$" && i === pattern.length - 1) return ends.includes(path.length);
    if (char === "*") {
      const first = ends[0] ?? 0;
      ends = Array.from({ length: path.length - first + 1 }, (_, offset) => first + offset);
    } else {
      ends = ends.filter((end) => path[end] === char).map((end) => end + 1);
      if (ends.length === 0) return false;
    }
  }
  return true;
}

/** Percent-encoded as a URL's path is, with uppercase hex, so a pattern and a path compare alike. */
function encoded(path: string) {
  let value = path;
  try {
    value = encodeURI(path).replace(/%25([0-9a-f]{2})/gi, "%$1");
  } catch {
    // A lone surrogate: compare it as written.
  }
  return value.replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}
