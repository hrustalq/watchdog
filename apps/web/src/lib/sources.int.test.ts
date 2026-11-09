import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createEgressFetch, loadConfig, pollSource } from "@watchdog/core";
import {
  closeDb,
  createDb,
  type Db,
  eq,
  item,
  itemLog,
  lte,
  migrate,
  source,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { feedPage } from "./feed.ts";
import {
  addGithubReleasesSource,
  addRssSource,
  type AddProblem,
  listSources,
  problemField,
  problemMessage,
  removeSource,
  type SourceDeps,
  watchedSourceName,
} from "./sources.ts";

const feed =
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Release notes</title>` +
  `<item><guid>one</guid><title>One</title><description>An entry.</description></item>` +
  `</channel></rss>`;

// No live HTTP: a server on loopback answers for feeds.test, which the allowlist lets through.
const pages: Record<string, { status: number; type: string; body: string }> = {
  "/news.rss": { status: 200, type: "application/rss+xml", body: feed },
  "/page.html": { status: 200, type: "text/html", body: "<!doctype html><p>A page</p>" },
};
// GitHub's answers, recorded on 2026-11-08 (packages/core/src/sources/github/fixtures): every repo's
// releases.atom is vercel/next.js's three newest releases, except a repo in `missingRepos`, which
// gets the 404 GitHub sends for a repo that doesn't exist.
const githubFixture = (name: string) =>
  readFileSync(new URL(`../../../../packages/core/src/sources/github/fixtures/${name}`, import.meta.url), "utf8");
const missingRepos = new Set<string>();
const githubPage = (repo: string) =>
  missingRepos.has(repo.toLowerCase())
    ? { status: 404, type: "text/plain; charset=utf-8", body: githubFixture("missing-repo-releases.txt") }
    : { status: 200, type: "application/atom+xml; charset=utf-8", body: githubFixture("vercel-next.js-releases.atom") };

const feeds = createServer((request, response) => {
  // The query string is ignored, so every test can add a feed URL of its own.
  const path = new URL(request.url ?? "/", "http://feeds.test").pathname;
  const repo = /^\/github\/([^/]+\/[^/]+)\/releases\.atom$/.exec(path)?.[1];
  const page = (repo === undefined ? pages[path] : githubPage(repo)) ?? {
    status: 404,
    type: "text/plain",
    body: "",
  };
  response.writeHead(page.status, { "content-type": page.type }).end(page.body);
});
let base = "";
const at = (path: string) => `${base}${path}`;
let feedCount = 0;
/** A feed URL no Workspace watches yet. */
const newFeed = () => {
  feedCount += 1;
  return at(`/news.rss?feed=${String(feedCount)}`);
};

// feeds.test is the server above, intranet.test a private address, and nothing else resolves.
const addresses: Record<string, string> = { "feeds.test": "127.0.0.1", "intranet.test": "10.0.0.1" };
const lookup = (host: string) => {
  const address = addresses[host];
  if (address === undefined) return Promise.reject(new Error(`getaddrinfo ENOTFOUND ${host}`));
  return Promise.resolve([{ address, family: 4 }]);
};
const env = {
  DATABASE_URL: "postgres://unused",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  WATCHDOG_ENCRYPTION_KEY: "A".repeat(43) + "=",
  EGRESS_ALLOWLIST: "feeds.test",
};
const guarded = createEgressFetch(loadConfig(env, () => undefined), { lookup });
const selfHosted: SourceDeps = { fetch: guarded, mode: "self-hosted" };

// github.com's releases feeds come from the server above, through the guarded fetch.
const githubFetches: string[] = [];
const github: SourceDeps = {
  mode: "self-hosted",
  fetch: (input, init) => {
    const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\.atom$/.exec(String(input))?.[1];
    if (repo === undefined) return guarded(input, init);
    githubFetches.push(repo);
    return guarded(at(`/github/${repo}/releases.atom`), init);
  },
};
// Just after the newest recorded release.
const pollDeps = { fetch: github.fetch, now: () => new Date("2026-11-09T00:00:00Z"), enqueueItems: () => Promise.resolve() };

describe("Sources", () => {
  let db: Db;
  let ours = "";
  let theirs = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => feeds.listen(0, "127.0.0.1", resolve));
    const address = feeds.address();
    if (address === null || typeof address === "string") throw new Error("The server has no port");
    base = `http://feeds.test:${String(address.port)}`;
    const postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values([
      { id: "us", name: "Us", email: "us@example.com" },
      { id: "them", name: "Them", email: "them@example.com" },
    ]);
    const [a, b] = await db
      .insert(workspace)
      .values([
        { name: "Ours", ownerUserId: "us" },
        { name: "Theirs", ownerUserId: "them" },
      ])
      .returning();
    ours = a?.id ?? "";
    theirs = b?.id ?? "";
    return async () => {
      await closeDb(db);
      await postgres.stop();
      feeds.close();
    };
  }, 120_000);

  const sourcesIn = (workspaceId: string) =>
    db.select().from(source).where(eq(source.workspaceId, workspaceId));

  async function added(workspaceId: string, input: { url: string; name?: string; schedule?: string }) {
    const result = await addRssSource(db, selfHosted, workspaceId, {
      name: "",
      schedule: "*/15 * * * *",
      ...input,
    });
    if (!("source" in result)) throw new Error(`Not added: ${result.problem}`);
    return result.source;
  }

  it("saves a valid feed URL as a Source the worker's next tick polls", async () => {
    const before = new Date();
    const url = newFeed();
    const { id } = await added(ours, { url });

    const [saved] = await db.select().from(source).where(eq(source.id, id));
    expect(saved).toMatchObject({
      workspaceId: ours,
      type: "rss",
      name: "Release notes",
      config: { url },
      schedule: "*/15 * * * *",
      lastPolledAt: null,
    });
    // The tick enqueues every Source with next_poll_at <= now().
    expect(saved?.nextPollAt?.getTime()).toBeLessThanOrEqual(Date.now());
    const due = await db.select({ id: source.id }).from(source).where(lte(source.nextPollAt, new Date()));
    expect(due.map((row) => row.id)).toContain(id);
    expect(saved?.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it("keeps the name the user gave, on one line and without NUL", async () => {
    const { id } = await added(ours, { url: newFeed(), name: "  Our\n  rel\u0000eases " });
    const [saved] = await db.select().from(source).where(eq(source.id, id));
    expect(saved?.name).toBe("Our releases");
  });

  it("caps a long name at 200 characters", async () => {
    const { id } = await added(ours, { url: newFeed(), name: "x".repeat(1000) });
    const [saved] = await db.select().from(source).where(eq(source.id, id));
    expect(saved?.name).toHaveLength(200);
  });

  it.each<[string, () => string, AddProblem, RegExp]>([
    ["isn't a URL", () => "not a url", "invalid-url", /full RSS feed URL/],
    ["isn't http or https", () => at("/news.rss").replace("http:", "ftp:"), "invalid-url", /full RSS feed URL/],
    ["isn't a feed", () => at("/page.html"), "not-a-feed", /isn't an RSS or Atom feed/],
    ["answers with an error", () => at("/gone.rss"), "answered", /feeds\.test answered HTTP 404/],
    ["can't be reached", () => "https://unreachable.test/feed.rss", "unreachable", /couldn't reach unreachable\.test/],
    ["resolves to a blocked address", () => "http://intranet.test/feed.rss", "blocked", /intranet\.test leads to a private/],
  ])("refuses a URL that %s and saves nothing", async (_case, url, problem, message) => {
    const before = (await sourcesIn(ours)).length;
    const result = await addRssSource(db, selfHosted, ours, {
      url: url(),
      name: "",
      schedule: "*/15 * * * *",
    });
    if ("source" in result) throw new Error("It was saved");
    expect(result.problem).toBe(problem);
    expect(problemField(result.problem)).toBe("url");
    const shown = { url: url(), status: result.status ?? "", mode: "self-hosted" as const };
    expect(problemMessage(result.problem, shown)).toMatch(message);
    expect(await sourcesIn(ours)).toHaveLength(before);
  });

  it.each(["*/5 * * * *", "* * * * *", "nonsense"])("refuses the schedule %s, before fetching", async (schedule) => {
    let fetched = false;
    const hosted: SourceDeps = {
      mode: "hosted",
      fetch: (...args) => {
        fetched = true;
        return guarded(...args);
      },
    };
    const before = (await sourcesIn(ours)).length;

    const result = await addRssSource(db, hosted, ours, { url: at("/news.rss"), name: "", schedule });

    expect(result).toEqual({ problem: "schedule" });
    expect(problemMessage("schedule", { url: "", status: "", mode: "hosted" })).not.toContain(schedule);
    expect(fetched).toBe(false);
    expect(await sourcesIn(ours)).toHaveLength(before);
  });

  it("lists only the Workspace's own Sources", async () => {
    const mine = await added(ours, { url: newFeed(), name: "Mine" });
    const other = await added(theirs, { url: newFeed(), name: "Other" });

    const listed = (await listSources(db, ours)).map((row) => row.id);
    expect(listed).toContain(mine.id);
    expect(listed).not.toContain(other.id);
  });

  it("removes a Source with its Items and their Logs", async () => {
    const { id } = await added(ours, { url: newFeed(), name: "Doomed" });
    const [captured] = await db
      .insert(item)
      .values({ workspaceId: ours, sourceId: id, externalId: "one", body: "An entry.", raw: {} })
      .returning();
    await db.insert(itemLog).values({ itemId: captured?.id ?? "", stage: "capture", message: "Captured" });

    expect(await removeSource(db, ours, id)).toBe(true);

    expect(await db.select().from(source).where(eq(source.id, id))).toEqual([]);
    expect(await db.select().from(item).where(eq(item.sourceId, id))).toEqual([]);
    expect(await db.select().from(itemLog).where(eq(itemLog.itemId, captured?.id ?? ""))).toEqual([]);
  });

  it("refuses a feed URL the Workspace already watches, in any host case, before fetching", async () => {
    const url = newFeed();
    await added(ours, { url, name: "Release notes" });
    let fetched = false;
    const counting: SourceDeps = {
      mode: "self-hosted",
      fetch: (...args) => {
        fetched = true;
        return guarded(...args);
      },
    };
    const before = (await sourcesIn(ours)).length;
    const again = url.replace("feeds.test", "Feeds.TEST");

    const result = await addRssSource(db, counting, ours, { url: again, name: "", schedule: "*/15 * * * *" });

    expect(result).toEqual({ problem: "duplicate" });
    expect(problemField("duplicate")).toBe("url");
    expect(fetched).toBe(false);
    expect(await sourcesIn(ours)).toHaveLength(before);
    const watching = await watchedSourceName(db, ours, { type: "rss", url: again, repo: "" });
    expect(watching).toBe("Release notes");
    const shown = { url: again, status: "", mode: "self-hosted" as const, source: watching };
    expect(problemMessage("duplicate", shown)).toBe(
      "This Workspace already watches that feed as the Source “Release notes”.",
    );
  });

  it("keeps one Source when the same feed URL is added twice at once", async () => {
    const url = newFeed();
    const input = { url, name: "", schedule: "*/15 * * * *" };
    // Each fetch waits for the other, so both adds pass the check before either inserts.
    const waiting: (() => void)[] = [];
    const together: SourceDeps = {
      mode: "self-hosted",
      fetch: async (...args) => {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) for (const go of waiting) go();
        });
        return guarded(...args);
      },
    };

    const results = await Promise.all([
      addRssSource(db, together, ours, input),
      addRssSource(db, together, ours, input),
    ]);

    expect(results.filter((result) => "source" in result)).toHaveLength(1);
    expect(results).toContainEqual({ problem: "duplicate" });
    const saved = (await sourcesIn(ours)).filter((row) => "url" in row.config && row.config.url === url);
    expect(saved).toHaveLength(1);
  });

  it("lets another Workspace add a feed URL this one watches", async () => {
    const url = newFeed();
    await added(ours, { url });

    const theirsToo = await added(theirs, { url });

    expect((await sourcesIn(theirs)).map((row) => row.id)).toContain(theirsToo.id);
  });

  it("treats another Workspace's Source, or an id that isn't one, as missing", async () => {
    const other = await added(theirs, { url: newFeed(), name: "Not ours" });

    expect(await removeSource(db, ours, other.id)).toBe(false);
    expect(await removeSource(db, ours, "not-a-uuid")).toBe(false);
    expect(await db.select().from(source).where(eq(source.id, other.id))).toHaveLength(1);
  });

  describe("GitHub releases", () => {
    const every15 = "*/15 * * * *";

    async function addedRepo(workspaceId: string, repo: string, name = "") {
      const result = await addGithubReleasesSource(db, github, workspaceId, { repo, name, schedule: every15 });
      if (!("source" in result)) throw new Error(`Not added: ${result.problem}`);
      return result.source;
    }

    it("saves a pasted repo URL as owner/repo, and its poll puts the recent releases in the Feed", async () => {
      const { id } = await addedRepo(ours, "https://github.com/vercel/next.js");

      const [saved] = await db.select().from(source).where(eq(source.id, id));
      expect(saved).toMatchObject({
        type: "github",
        name: "vercel/next.js releases",
        config: { kind: "releases", repo: "vercel/next.js" },
        dedupKey: "releases:vercel/next.js",
        schedule: every15,
        lastError: null,
      });
      expect(saved?.nextPollAt?.getTime()).toBeLessThanOrEqual(Date.now());

      expect(await pollSource(db, id, pollDeps)).toEqual({ captured: 3 });
      const { items } = await feedPage(db, ours);
      const captured = items.filter((row) => row.sourceName === "vercel/next.js releases");
      expect(captured.map((row) => row.title).sort()).toEqual([
        "v16.5.0-canary.43",
        "v16.5.0-canary.44",
        "v16.5.0-canary.45",
      ]);
      expect(captured.every((row) => row.isBackfill)).toBe(true);
      const stored = await db.select({ externalId: item.externalId }).from(item).where(eq(item.sourceId, id));
      expect(stored.map((row) => row.externalId)).toContain(
        "tag:github.com,2008:Repository/70107786/v16.5.0-canary.45",
      );
    });

    it("refuses the same repo's releases again, in any case or form, and names the Source", async () => {
      await addedRepo(ours, "nodejs/node", "Node releases");
      const fetchesBefore = githubFetches.length;
      const before = (await sourcesIn(ours)).length;
      const again = "https://github.com/NodeJS/Node/releases";

      const result = await addGithubReleasesSource(db, github, ours, { repo: again, name: "", schedule: every15 });

      expect(result).toEqual({ problem: "duplicate" });
      expect(githubFetches).toHaveLength(fetchesBefore);
      expect(await sourcesIn(ours)).toHaveLength(before);
      expect(problemField("duplicate", "github-releases")).toBe("repo");
      const values = { type: "github-releases" as const, url: "", repo: again };
      const watching = await watchedSourceName(db, ours, values);
      expect(watching).toBe("Node releases");
      const shown = { ...values, status: "", mode: "self-hosted" as const, source: watching };
      expect(problemMessage("duplicate", shown)).toBe(
        "This Workspace already watches the releases of NodeJS/Node as the Source “Node releases”.",
      );
    });

    it("lets another Workspace watch a repo's releases this one watches", async () => {
      await addedRepo(ours, "denoland/deno");
      const { id } = await addedRepo(theirs, "denoland/deno");
      expect((await sourcesIn(theirs)).map((row) => row.id)).toContain(id);
    });

    it("refuses a repo GitHub has no public repo for, and saves nothing", async () => {
      missingRepos.add("octo-org/private-thing");
      const before = (await sourcesIn(ours)).length;

      const result = await addGithubReleasesSource(db, github, ours, {
        repo: "octo-org/private-thing",
        name: "",
        schedule: every15,
      });

      expect(result).toEqual({ problem: "no-repo" });
      expect(problemField("no-repo", "github-releases")).toBe("repo");
      const shown = { type: "github-releases" as const, url: "", repo: "octo-org/private-thing", status: "", mode: "hosted" as const };
      expect(problemMessage("no-repo", shown)).toBe(
        "GitHub has no public repo octo-org/private-thing. Check the name: only a public repo's releases can be watched.",
      );
      expect(await sourcesIn(ours)).toHaveLength(before);
    });

    it("leaves a readable last error on the Source when its repo is gone", async () => {
      const { id } = await addedRepo(ours, "octo-org/vanishing");
      missingRepos.add("octo-org/vanishing");

      const message = "GitHub has no public repo octo-org/vanishing. It may have been renamed, deleted or made private.";
      expect(await pollSource(db, id, pollDeps)).toEqual({ error: message });

      const [saved] = await db.select().from(source).where(eq(source.id, id));
      expect(saved?.lastError).toBe(message);
      expect(saved?.lastPolledAt).toBeNull();
    });

    it.each(["", "vercel", "https://gitlab.com/vercel/next.js", "vercel/next js"])(
      "refuses the repo %j before fetching",
      async (repo) => {
        const fetchesBefore = githubFetches.length;
        const result = await addGithubReleasesSource(db, github, ours, { repo, name: "", schedule: every15 });

        expect(result).toEqual({ problem: "invalid-repo" });
        expect(problemField("invalid-repo", "github-releases")).toBe("repo");
        const shown = { type: "github-releases" as const, url: "", repo, status: "", mode: "hosted" as const };
        expect(problemMessage("invalid-repo", shown)).toBe(
          "Enter a GitHub repo as owner/name, such as vercel/next.js, or paste its URL.",
        );
        expect(githubFetches).toHaveLength(fetchesBefore);
      },
    );

    it("refuses a schedule outside the form's list, before fetching", async () => {
      const fetchesBefore = githubFetches.length;
      const result = await addGithubReleasesSource(db, github, ours, {
        repo: "rust-lang/rust",
        name: "",
        schedule: "* * * * *",
      });
      expect(result).toEqual({ problem: "schedule" });
      expect(githubFetches).toHaveLength(fetchesBefore);
    });
  });
});
