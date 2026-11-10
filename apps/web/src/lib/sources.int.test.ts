import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createEgressFetch, decryptSecret, linkChat, loadConfig, pollSource } from "@watchdog/core";
import {
  account,
  and,
  closeDb,
  createDb,
  type Db,
  eq,
  item,
  itemLog,
  lte,
  migrate,
  source,
  sql,
  user,
  workspace,
} from "@watchdog/db";
import { startPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { feedPage } from "./feed.ts";
import {
  addGithubIssuesSource,
  addGithubMentionsSource,
  addGithubReleasesSource,
  addRssSource,
  addTelegramSource,
  addValues,
  addWebsiteSource,
  type AddProblem,
  checkSourceNow,
  listSources,
  newSourceLink,
  problemField,
  problemMessage,
  removeSource,
  type SourceDeps,
  sourceLinkCookieValue,
  sourceLinkInCookie,
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
const encryptionKey = Buffer.alloc(32, 3);
const selfHosted: SourceDeps = { fetch: guarded, mode: "self-hosted", encryptionKey };

// github.com's releases feeds come from the server above, through the guarded fetch.
const githubFetches: string[] = [];
const github: SourceDeps = {
  mode: "self-hosted",
  encryptionKey,
  fetch: (input, init) => {
    const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\.atom$/.exec(String(input))?.[1];
    if (repo === undefined) return guarded(input, init);
    githubFetches.push(repo);
    return guarded(at(`/github/${repo}/releases.atom`), init);
  },
};
// Just after the newest recorded release.
const pollDeps = {
  fetch: github.fetch,
  now: () => new Date("2026-11-09T00:00:00Z"),
  enqueueItems: () => Promise.resolve(),
  secrets: { encryptionKey: Buffer.alloc(32), authSecret: "unused-by-rss-sources" },
};

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
      encryptionKey,
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

  it("lists a Source's Health, its last success and whether a poll is due", async () => {
    const { id } = await added(ours, { url: newFeed(), name: "Flaky" });
    const lastSuccessAt = new Date("2026-11-09T08:00:00Z");
    const later = new Date(Date.now() + 3_600_000);
    await db.update(source).set({ health: "failing", lastSuccessAt, nextPollAt: later }).where(eq(source.id, id));

    const listed = (await listSources(db, ours)).find((row) => row.id === id);
    expect(listed).toMatchObject({ health: "failing", lastSuccessAt, due: false });
  });

  it("makes a Schedule Source due on Check now, so the worker's next tick polls it", async () => {
    const { id } = await added(ours, { url: newFeed(), name: "Checked" });
    // A failing Source waits an hour between polls, and Check now doesn't.
    const later = new Date(Date.now() + 3_600_000);
    await db.update(source).set({ health: "failing", nextPollAt: later }).where(eq(source.id, id));

    expect(await checkSourceNow(db, ours, id)).toBe(true);

    expect(await db.select({ id: source.id }).from(source).where(and(eq(source.id, id), lte(source.nextPollAt, sql`now()`)))).toHaveLength(1);
    expect((await listSources(db, ours)).find((row) => row.id === id)?.due).toBe(true);
  });

  it("checks nothing for another Workspace's Source, an id that isn't one, or a Source that isn't polled", async () => {
    const other = await added(theirs, { url: newFeed(), name: "Not ours" });
    const later = new Date(Date.now() + 3_600_000);
    await db.update(source).set({ nextPollAt: later }).where(eq(source.id, other.id));
    const { source: telegram } = await addTelegramSource(db, ours, { name: "Never polled" });

    expect(await checkSourceNow(db, ours, other.id)).toBe(false);
    expect(await checkSourceNow(db, ours, "not-an-id")).toBe(false);
    expect(await checkSourceNow(db, ours, telegram.id)).toBe(false);

    const [theirsAfter] = await db.select().from(source).where(eq(source.id, other.id));
    expect(theirsAfter?.nextPollAt).toEqual(later);
    const [telegramAfter] = await db.select().from(source).where(eq(source.id, telegram.id));
    expect(telegramAfter?.nextPollAt).toBeNull();
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
      encryptionKey,
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
      encryptionKey,
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
  describe("GitHub issues and mentions", () => {
    const every15 = "*/15 * * * *";
    let signedIn = "";
    let tokenless = "";

    beforeAll(async () => {
      await db.insert(user).values([
        { id: "octocat", name: "Octocat", email: "octocat@example.com" },
        { id: "nobody", name: "Nobody", email: "nobody@example.com" },
      ]);
      await db.insert(account).values({
        id: "octocat-github",
        accountId: "583231",
        providerId: "github",
        userId: "octocat",
        accessToken: "gho_signin",
      });
      const [a, b] = await db
        .insert(workspace)
        .values([
          { name: "Signed in", ownerUserId: "octocat" },
          { name: "Tokenless", ownerUserId: "nobody" },
        ])
        .returning();
      signedIn = a?.id ?? "";
      tokenless = b?.id ?? "";
    });

    const issues = (workspaceId: string, repo: string, token = "") =>
      addGithubIssuesSource(db, github, workspaceId, { repo, token, name: "", schedule: every15 });
    const mentions = (workspaceId: string, term: string, within = "", token = "") =>
      addGithubMentionsSource(db, github, workspaceId, { term, within, token, name: "", schedule: every15 });
    const saved = async (result: Awaited<ReturnType<typeof issues>>) => {
      if (!("source" in result)) throw new Error(`Not added: ${result.problem}`);
      return (await db.select().from(source).where(eq(source.id, result.source.id)))[0];
    };

    it("saves an issues Source with a pasted token, encrypted and never listed", async () => {
      const token = "github_pat_11ABCDEFG0pasted";
      const row = await saved(await issues(tokenless, " https://github.com/microsoft/vscode/issues ", ` ${token} `));

      expect(row).toMatchObject({
        type: "github",
        name: "microsoft/vscode issues",
        config: { kind: "issues", repo: "microsoft/vscode" },
        dedupKey: "issues:microsoft/vscode",
        schedule: every15,
      });
      expect(row?.secretCiphertext).not.toContain(token);
      expect(decryptSecret(row?.secretCiphertext ?? "", encryptionKey)).toBe(token);
      const listed = (await listSources(db, tokenless)).find((entry) => entry.id === row?.id);
      expect(listed).toBeDefined();
      expect(JSON.stringify(listed)).not.toContain(row?.secretCiphertext ?? "");
      expect(listed).not.toHaveProperty("secretCiphertext");
    });

    it("saves an issues Source on the owner's GitHub sign-in token, storing no token of its own", async () => {
      const row = await saved(await issues(signedIn, "denoland/deno"));
      expect(row).toMatchObject({ config: { kind: "issues", repo: "denoland/deno" }, secretCiphertext: null });
    });

    it("saves nothing without a pasted or a sign-in token, and says what to do", async () => {
      const before = (await sourcesIn(tokenless)).length;

      expect(await issues(tokenless, "denoland/deno")).toEqual({ problem: "no-token" });
      expect(await mentions(tokenless, "watchdog")).toEqual({ problem: "no-token" });

      expect(await sourcesIn(tokenless)).toHaveLength(before);
      expect(problemField("no-token", "github-issues")).toBe("token");
      const shown = { type: "github-issues" as const, url: "", status: "", mode: "hosted" as const };
      expect(problemMessage("no-token", shown)).toBe(
        "Paste a fine-grained personal access token: this Workspace has no GitHub sign-in to read GitHub's API with.",
      );
    });

    it("refuses a token with spaces in it", async () => {
      expect(await issues(tokenless, "denoland/deno", "github_pat one")).toEqual({ problem: "invalid-token" });
    });

    it("saves a mentions Source limited to a repo or an org, and refuses the same search again", async () => {
      const inRepo = await saved(await mentions(signedIn, "  hydration mismatch ", "https://github.com/vercel/next.js"));
      expect(inRepo).toMatchObject({
        name: "hydration mismatch in vercel/next.js",
        config: { kind: "mentions", term: "hydration mismatch", within: "repo:vercel/next.js" },
        dedupKey: "mentions:repo:vercel/next.js:hydration mismatch",
      });
      const inOrg = await saved(await mentions(signedIn, "hydration mismatch", "vercel"));
      expect(inOrg?.config).toEqual({ kind: "mentions", term: "hydration mismatch", within: "org:vercel" });
      const anywhere = await saved(await mentions(signedIn, "watchdog"));
      expect(anywhere).toMatchObject({ name: "watchdog on GitHub", config: { kind: "mentions", term: "watchdog" } });

      expect(await mentions(signedIn, "hydration mismatch", "Vercel/Next.js")).toEqual({ problem: "duplicate" });
      const values = { type: "github-mentions" as const, url: "", repo: "", term: "hydration mismatch", within: "vercel/next.js" };
      const watching = await watchedSourceName(db, signedIn, values);
      expect(watching).toBe("hydration mismatch in vercel/next.js");
      expect(problemMessage("duplicate", { ...values, status: "", mode: "hosted", source: watching })).toBe(
        "This Workspace already searches GitHub for “hydration mismatch” as the Source “hydration mismatch in vercel/next.js”.",
      );
    });

    it("refuses the same repo's issues again, in any case", async () => {
      await issues(signedIn, "nodejs/node");
      expect(await issues(signedIn, "NodeJS/Node")).toEqual({ problem: "duplicate" });
    });

    it.each([
      ["", "invalid-term"],
      ["x".repeat(101), "invalid-term"],
    ] as const)("refuses the term %j", async (term, problem) => {
      expect(await mentions(signedIn, term)).toEqual({ problem });
      expect(problemField(problem, "github-mentions")).toBe("term");
    });

    it("drops a NUL from the term, which Postgres can't store", async () => {
      const row = await saved(await mentions(signedIn, "nul\0term"));
      expect(row?.config).toEqual({ kind: "mentions", term: "nulterm" });
    });

    it("refuses a limit that is neither an org nor a repo", async () => {
      expect(await mentions(signedIn, "watchdog", "https://gitlab.com/vercel")).toEqual({ problem: "invalid-within" });
      expect(problemField("invalid-within", "github-mentions")).toBe("within");
    });

    it("never carries a posted token back in the form's values", () => {
      const posted: Record<string, string> = { type: "github-issues", repo: "a/b", token: "github_pat_secret" };
      const values = addValues((name) => posted[name] ?? "");
      expect(values.type).toBe("github-issues");
      expect(Object.values(values)).not.toContain("github_pat_secret");
    });
  });

  describe("websites", () => {
    const every15 = "*/15 * * * *";
    const website = (
      workspaceId: string,
      input: { url?: string; region?: string; ignore?: string; ignoreRobots?: string; render?: string; name?: string },
      deps = selfHosted,
    ) =>
      addWebsiteSource(db, deps, workspaceId, {
        url: at("/page.html"),
        region: "",
        ignore: "",
        ignoreRobots: "",
        render: "static",
        name: "",
        schedule: every15,
        ...input,
      });
    let pageCount = 0;
    /** A page URL no Workspace watches yet. */
    const newPage = () => {
      pageCount += 1;
      return at(`/page.html?page=${String(pageCount)}`);
    };
    const savedSource = async (result: Awaited<ReturnType<typeof website>>) => {
      if (!("source" in result)) throw new Error(`Not added: ${result.problem}`);
      const [row] = await db.select().from(source).where(eq(source.id, result.source.id));
      return row;
    };

    it("saves the page, Region and ignore patterns, and its first poll stores the Baseline", async () => {
      const url = newPage();
      const row = await savedSource(
        await website(ours, { url, region: "  #pricing .plan ", ignore: String.raw`\d+ visitors` + "\n\n  Updated .* ago  \n" }),
      );
      expect(row).toMatchObject({
        type: "website",
        name: `feeds.test/page.html`,
        config: { url, region: "#pricing .plan", ignore: [String.raw`\d+ visitors`, "Updated .* ago"], render: "static" },
        dedupKey: `${url} #pricing .plan`,
        schedule: every15,
      });
      expect(row?.config).not.toHaveProperty("ignoreRobots");

      const whole = await savedSource(await website(ours, { url: newPage(), name: "Landing page" }));
      expect(whole?.config).toMatchObject({ ignore: [], render: "static" });
      expect(whole?.config).not.toHaveProperty("region");
      // robots.txt answers 404 on the test server, which allows everything.
      expect(await pollSource(db, whole?.id ?? "", pollDeps)).toEqual({ captured: 0 });
      const [polled] = await db.select().from(source).where(eq(source.id, whole?.id ?? ""));
      expect(polled?.fetchState.text).toBe("A page");
      expect(polled?.lastError).toBeNull();
    });

    it("keeps robots.txt off only on self-hosted", async () => {
      const kept = await savedSource(await website(ours, { url: newPage(), ignoreRobots: "on" }));
      expect(kept?.config).toMatchObject({ ignoreRobots: true });
      const hosted = { ...selfHosted, mode: "hosted" as const };
      const dropped = await savedSource(await website(ours, { url: newPage(), ignoreRobots: "on" }, hosted));
      expect(dropped?.config).not.toHaveProperty("ignoreRobots");
    });

    it("renders the page through Obscura or Chromium only on an install that runs it", async () => {
      const both = { ...selfHosted, renderers: { obscura: true, chromium: true } };
      const rendered = await savedSource(await website(ours, { url: newPage(), render: "obscura" }, both));
      expect(rendered?.config).toMatchObject({ render: "obscura" });
      const fallback = await savedSource(await website(ours, { url: newPage(), render: "chromium" }, both));
      expect(fallback?.config).toMatchObject({ render: "chromium" });
      // Anything else posted is the static fetch.
      const other = await savedSource(await website(ours, { url: newPage(), render: "firefox" }, both));
      expect(other?.config).toMatchObject({ render: "static" });

      const before = (await sourcesIn(ours)).length;
      expect(await website(ours, { url: newPage(), render: "obscura" })).toEqual({ problem: "render-unavailable" });
      const obscuraOnly = { ...selfHosted, renderers: { obscura: true, chromium: false } };
      expect(await website(ours, { url: newPage(), render: "chromium" }, obscuraOnly)).toEqual({
        problem: "render-unavailable",
      });
      expect((await sourcesIn(ours)).length).toBe(before);
      expect(problemField("render-unavailable", "website")).toBe("render");
      const values = { ...addValues(() => ""), type: "website" as const, url: newPage() };
      expect(problemMessage("render-unavailable", { ...values, render: "obscura", status: "", mode: "self-hosted" })).toBe(
        "This install doesn't run Obscura, the browser that renders pages, so choose Static.",
      );
      expect(problemMessage("render-unavailable", { ...values, render: "chromium", status: "", mode: "self-hosted" })).toBe(
        "This install doesn't run the Chromium fallback, so choose another way to read the page.",
      );
    });

    it("carries the render mode back in the form's values, and nothing but a renderer counts", () => {
      expect(addValues((name) => (name === "render" ? "obscura" : "")).render).toBe("obscura");
      expect(addValues((name) => (name === "render" ? "chromium" : "")).render).toBe("chromium");
      expect(addValues((name) => (name === "render" ? "firefox" : "")).render).toBe("static");
    });

    it("refuses the same page and Region twice, but watches another Region of it", async () => {
      const url = newPage();
      await website(ours, { url, region: "main", name: "Pricing" });
      expect(await website(ours, { url, region: " main " })).toEqual({ problem: "duplicate" });
      const values = { ...addValues(() => ""), type: "website" as const, url, region: "main" };
      const watching = await watchedSourceName(db, ours, values);
      expect(watching).toBe("Pricing");
      expect(problemMessage("duplicate", { ...values, status: "", mode: "hosted", source: watching })).toBe(
        "This Workspace already watches that part of that page as the Source “Pricing”.",
      );
      expect("source" in (await website(ours, { url, region: "aside" }))).toBe(true);
      expect("source" in (await website(theirs, { url, region: "main" }))).toBe(true);
    });

    it.each([
      [{ url: "example.com/pricing" }, "invalid-url", "url", "Enter the full page URL, starting with https://."],
      [
        { region: "main[data-plan" },
        "invalid-region",
        "region",
        "That isn't a CSS selector Watchdog can match. Enter one such as main or #pricing .plan, or leave it empty to watch the whole page.",
      ],
      [
        { region: "section:has(.price)" },
        "invalid-region",
        "region",
        "The region can't use :has(). Select the element itself, such as #pricing .plan.",
      ],
      [
        { ignore: "\\d+ visitors\n(unclosed" },
        "invalid-ignore",
        "ignore",
        "Line 2 isn't a regular expression Watchdog can run. Ignore patterns use RE2 syntax, such as \\d+ visitors.",
      ],
      [
        { ignore: "\\d+ visitors\n\n(unclosed" },
        "invalid-ignore",
        "ignore",
        "Line 3 isn't a regular expression Watchdog can run. Ignore patterns use RE2 syntax, such as \\d+ visitors.",
      ],
      [
        { ignore: Array.from({ length: 21 }, (_, i) => `x${String(i)}`).join("\n") },
        "invalid-ignore",
        "ignore",
        "Enter at most 20 ignore patterns, one a line.",
      ],
    ] as const)("refuses %j", async (input, problem, field, message) => {
      const before = (await sourcesIn(ours)).length;
      expect(await website(ours, input)).toEqual({ problem });
      expect(problemField(problem, "website")).toBe(field);
      const values = { ...addValues(() => ""), url: at("/page.html"), ...input, type: "website" as const };
      expect(problemMessage(problem, { ...values, status: "", mode: "hosted" })).toBe(message);
      expect(await sourcesIn(ours)).toHaveLength(before);
    });
  });
  describe("Telegram bot", () => {
    const key = Buffer.alloc(32);
    const group = (id: string) => ({ id, title: "Ops room", type: "supergroup" });
    const rowOf = async (id: string) => (await listSources(db, ours)).find((row) => row.id === id);

    it("saves a Source waiting for the bot, with no schedule, and a code that binds a group to it", async () => {
      const { source: telegram, code } = await addTelegramSource(db, ours, { name: "" });

      expect(await rowOf(telegram.id)).toMatchObject({ type: "telegram", name: "Telegram chat", config: { via: "bot" }, schedule: null });
      expect(await linkChat(db, key, code, group("-100900"))).toBe("Watching this chat for Telegram chat in Watchdog");
      expect((await rowOf(telegram.id))?.config).toEqual({ via: "bot", chatId: -100900, title: "Ops room" });
    });

    it("shows the link from the cookie while the Source waits, and that it's bound once the bot has the code", async () => {
      const { source: telegram, code } = await addTelegramSource(db, ours, { name: "Ops" });
      const cookie = sourceLinkCookieValue(telegram.id, code);

      expect(await sourceLinkInCookie(db, await listSources(db, ours), cookie)).toMatchObject({
        status: "pending",
        id: telegram.id,
        name: "Ops",
        code,
      });
      await linkChat(db, key, code, group("-100901"));
      expect(await sourceLinkInCookie(db, await listSources(db, ours), cookie)).toEqual({
        status: "linked",
        id: telegram.id,
        name: "Ops",
      });
      // Another Workspace's list doesn't have the Source.
      expect(await sourceLinkInCookie(db, await listSources(db, theirs), cookie)).toBeUndefined();
    });

    it("gives a new code to a Source that waits or lost access, in this Workspace only", async () => {
      const { source: telegram, code } = await addTelegramSource(db, ours, { name: "" });

      expect(await newSourceLink(db, theirs, telegram.id)).toBeUndefined();
      expect(await newSourceLink(db, ours, "not-a-uuid")).toBeUndefined();
      await linkChat(db, key, code, group("-100902"));
      expect(await newSourceLink(db, ours, telegram.id)).toBeUndefined();

      await db.update(source).set({ health: "failing", lastError: "The bot was removed" }).where(eq(source.id, telegram.id));
      const again = await newSourceLink(db, ours, telegram.id);
      expect(again).toMatch(/^[\w-]{22}$/);
      expect(await linkChat(db, key, again ?? "", group("-100902"))).toMatch(/^Watching this chat/);
      expect(await rowOf(telegram.id)).toMatchObject({ health: "ok", lastError: null });
    });

    it("never takes a new code for a Source of another type", async () => {
      const rss = await added(ours, { url: at("/news.rss?telegram-test") });

      expect(await newSourceLink(db, ours, rss.id)).toBeUndefined();
    });

    it("never takes a code for a failing Source that reads through the user session, which a link would make a bot Source", async () => {
      const [session] = await db
        .insert(source)
        .values({
          workspaceId: ours,
          type: "telegram",
          name: "Ops room",
          config: { via: "session", chatId: -100903, title: "Ops room" },
          schedule: null,
          nextPollAt: null,
          health: "failing",
          lastError: "The Telegram session was revoked",
        })
        .returning();

      expect(await newSourceLink(db, ours, session?.id ?? "")).toBeUndefined();
    });
  });
});
