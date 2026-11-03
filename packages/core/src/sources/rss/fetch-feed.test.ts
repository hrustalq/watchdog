import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../config.ts";
import { createEgressFetch, EgressBlockedError } from "../../egress/egress.ts";
import { maxBodyBytes } from "../item.ts";
import { fetchFeed } from "./fetch-feed.ts";

// Real feeds recorded on 2026-11-03 and trimmed to their first three entries, except
// google-alerts.atom, which is constructed (see the comment in it).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const rss = (items: string) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Inline</title>` +
  `<link>https://feeds.test/</link><description>Inline</description>${items}</channel></rss>`;

// A local server stands in for the internet, as in the egress guard's tests: feeds.test resolves
// to it and is allowlisted, while blocked.test resolves to a private address.
const requests: IncomingMessage[] = [];
let server: Server;
let base: string;
const config = loadConfig(
  {
    DATABASE_URL: "postgres://watchdog:watchdog@localhost:5432/watchdog",
    BETTER_AUTH_SECRET: "a".repeat(32),
    BETTER_AUTH_URL: "http://localhost:3000",
    EGRESS_ALLOWLIST: "feeds.test",
  },
  () => undefined,
);
const dns: Record<string, string> = { "feeds.test": "127.0.0.1", "blocked.test": "10.0.0.1" };
const deps = {
  fetch: createEgressFetch(config, {
    lookup: (host) => {
      const address = dns[host];
      return Promise.resolve(address === undefined ? [] : [{ address, family: 4 }]);
    },
  }),
};

const inline: Record<string, string> = {
  "/relative.rss": rss(
    `<item><title>Relative</title><link>/posts/1</link><description>One</description></item>`,
  ),
  "/no-id.rss": rss(
    `<item><title>No guid or link</title><description>Skipped</description></item>` +
      `<item><title>Link only</title><link>https://feeds.test/posts/2</link></item>`,
  ),
  "/feed.json": JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: [] }),
  "/unsafe-link.rss": rss(
    `<item><guid>a</guid><link>javascript:alert(1)</link></item>` +
      `<item><guid>b</guid><link>data:text/html,hi</link></item>`,
  ),
  "/text-content.atom":
    `<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><id>t</id><entry><id>e1</id>` +
    `<title>Plain</title><content type="text">Use the &amp;lt;details&amp;gt; element</content>` +
    `<link rel="enclosure" href="https://feeds.test/ep1.mp3"/>` +
    `<updated>2026-11-02T10:00:00</updated></entry></feed>`,
  // 40 000 two-byte characters: 80 000 bytes, and any cut at an odd byte splits a character.
  "/huge.rss": rss(
    `<item><guid>huge</guid><description>${"é".repeat(40_000)}</description></item>`,
  ),
};

// windows-1251, as many Russian sites still serve their feeds: "Привет" is CF F0 E8 E2 E5 F2.
const cp1251 = Buffer.concat([
  Buffer.from(`<?xml version="1.0" encoding="windows-1251"?><rss version="2.0"><channel><title>`),
  Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
  Buffer.from(`</title><item><guid>1</guid><title>`),
  Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
  Buffer.from(`</title></item></channel></rss>`),
]);

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req);
    const path = req.url ?? "";
    const name = /^\/fixtures\/(.+)$/.exec(path)?.[1];
    const body = name === undefined ? inline[path] : fixture(name);
    if (path === "/conditional.rss") {
      if (req.headers["if-none-match"] === '"v1"') res.writeHead(304).end();
      else {
        res.writeHead(200, { etag: '"v1"', "last-modified": "Mon, 02 Nov 2026 00:00:00 GMT" });
        res.end(fixture("postgresql-news.rss"));
      }
    } else if (path === "/cp1251.rss") res.end(cp1251);
    else if (path === "/cp1251-header.rss") {
      res.writeHead(200, { "content-type": "application/rss+xml; charset=windows-1251" });
      res.end(cp1251.toString("latin1").replace(` encoding="windows-1251"`, ""), "latin1");
    } else if (body === undefined) res.writeHead(404).end();
    else res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  base = `http://feeds.test:${String(address.port)}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function entriesOf(path: string) {
  const result = await fetchFeed(`${base}${path}`, {}, deps);
  if ("notModified" in result) throw new Error(`${path} answered 304`);
  return result.entries;
}

describe("fetchFeed", () => {
  it.each([
    {
      fixture: "postgresql-news.rss",
      externalId: "https://www.postgresql.org/about/news/security-release-for-psqlodbc-3431/",
      url: "https://www.postgresql.org/about/news/security-release-for-psqlodbc-3431/",
      title: "Security release for psqlodbc",
      author: null,
      publishedAt: "2026-11-02T00:00:00.000Z",
      bodyStart: "The PostgreSQL ODBC project has released version 18.00.0006",
    },
    {
      fixture: "github-releases.atom",
      externalId: "tag:github.com,2008:Repository/27193779/v27.0.0-alpha.0.0.0",
      url: "https://github.com/nodejs/node/releases/tag/v27.0.0-alpha.0.0.0",
      title: "2026-10-29, Version 27.0.0-alpha.0.0.0 (Alpha), @RafaelGSS",
      author: "RafaelGSS",
      publishedAt: "2026-10-29T18:36:37.000Z",
      bodyStart: "Notable Changes V8 15.6",
    },
    {
      fixture: "hnrss.rss",
      externalId: "https://news.ycombinator.com/item?id=50351409",
      url: "https://github.com/lokadb/lokadb",
      title: "Show HN: LokaDB – store each SaaS clients rows in a separate Postgres database",
      author: "kagen",
      publishedAt: "2026-11-03T12:51:40.000Z",
      bodyStart: "Article URL: https://github.com/lokadb/lokadb Comments URL:",
    },
    {
      fixture: "reddit-search.atom",
      externalId: "t3_1xmuvjo",
      url: "https://www.reddit.com/r/Programmers_forhire/comments/1xmuvjo/looking_for_someone_to_bring_freelance/",
      title:
        "Looking for someone to bring freelance development projects — commission per successful project",
      author: "/u/Actual_Maybe_3451",
      publishedAt: "2026-11-03T14:47:22.000Z",
      bodyStart: "Hi everyone, I’m a full-stack developer",
    },
    {
      fixture: "google-alerts.atom",
      externalId: "tag:google.com,2013:googlealerts/feed:2222222222222222201",
      url: "https://www.google.com/url?rct=j&sa=t&url=https://engineering.example.com/scaling-postgres&ct=ga&cd=CAIyAA&usg=AOvVaw0000000000000000000001",
      title: "Scaling Postgres to a billion rows",
      author: null,
      publishedAt: "2026-11-03T09:15:00.000Z",
      bodyStart: "How we partitioned our Postgres tables & kept p99 latency under 20 ms ...",
    },
    {
      fixture: "wordpress-news.rss",
      externalId: "https://wordpress.org/news/?p=21896",
      url: "https://wordpress.org/news/2026/10/wordpress-7-1-4/",
      title: "WordPress 7.1.4",
      author: "Aaron Jorbin",
      publishedAt: "2026-10-28T17:13:02.000Z",
      bodyStart: "This security release features fixes for multiple issues. Because this is",
    },
    {
      // RSS 1.0 has no guid, so the link is the external ID.
      fixture: "debian-news.rdf",
      externalId: "https://www.debian.org/News/2026/20260912",
      url: "https://www.debian.org/News/2026/20260912",
      title: "Updated Debian 13: 13.7 released",
      author: null,
      publishedAt: "2026-09-12T00:00:00.000Z",
      bodyStart: "The Debian project is pleased to announce the seventh update of its stable",
    },
  ])("maps $fixture entries to the Item envelope", async (expected) => {
    const { fixture: name, bodyStart, ...first } = expected;
    const entries = await entriesOf(`/fixtures/${name}`);

    expect(entries.length).toBeGreaterThanOrEqual(2);
    const [entry] = entries;
    expect({
      externalId: entry?.externalId,
      url: entry?.url,
      title: entry?.title,
      author: entry?.author,
      publishedAt: entry?.publishedAt?.toISOString() ?? null,
    }).toEqual(first);
    expect(entry?.body.startsWith(bodyStart)).toBe(true);
    expect(entry?.raw).toBeTypeOf("object");
    for (const { externalId, body } of entries) {
      expect(externalId).not.toBe("");
      // Escaped text such as `--experimental-wasm-&lt;name&gt;` decodes to a literal "<name>",
      // so this looks for the HTML elements the fixtures use rather than anything in brackets.
      expect(body).not.toMatch(
        /<!--|<\/?(?:a|b|blockquote|br|code|div|em|h\d|i|img|li|ol|p|pre|span|strong|ul)\b[^>]*>/i,
      );
      expect(body).not.toMatch(/&(?:[a-z]+|#\d+);/i);
      expect(body).not.toMatch(/\s{2}/);
    }
  });

  it("returns the feed title", async () => {
    const result = await fetchFeed(`${base}/fixtures/hnrss.rss`, {}, deps);
    expect(result).toMatchObject({ feedTitle: 'Hacker News - Newest: "postgres"' });
  });

  it("caps a body over 32 KB on a character boundary", async () => {
    const [github] = await entriesOf("/fixtures/github-releases.atom");
    const [huge] = await entriesOf("/huge.rss");

    for (const body of [github?.body ?? "", huge?.body ?? ""]) {
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(maxBodyBytes);
      expect(Buffer.byteLength(body)).toBeGreaterThan(maxBodyBytes - 4);
    }
    expect(huge?.body).toBe("é".repeat(maxBodyBytes / 2));
  });

  it("resolves relative links against the feed URL", async () => {
    const [entry] = await entriesOf("/relative.rss");
    expect(entry).toMatchObject({
      externalId: `${base}/posts/1`,
      url: `${base}/posts/1`,
    });
  });

  it("falls back to the link for the external ID and skips an entry with neither", async () => {
    const entries = await entriesOf("/no-id.rss");
    expect(entries.map((entry) => entry.externalId)).toEqual(["https://feeds.test/posts/2"]);
    expect(entries[0]).toMatchObject({ body: "", publishedAt: null, author: null });
  });

  it.each(["/fixtures/html-page.html", "/feed.json"])(
    'fails on %s with "not an RSS or Atom feed"',
    async (path) => {
      await expect(fetchFeed(`${base}${path}`, {}, deps)).rejects.toThrow(
        "not an RSS or Atom feed",
      );
    },
  );

  it("fails on an error status", async () => {
    await expect(fetchFeed(`${base}/missing.rss`, {}, deps)).rejects.toThrow("404");
  });

  it("sends the stored fetch state and reports a 304 as not modified", async () => {
    const first = await fetchFeed(`${base}/conditional.rss`, {}, deps);
    expect(first).toMatchObject({
      fetchState: { etag: '"v1"', lastModified: "Mon, 02 Nov 2026 00:00:00 GMT" },
    });
    if ("notModified" in first) throw new Error("first fetch answered 304");

    const second = await fetchFeed(`${base}/conditional.rss`, first.fetchState, deps);

    expect(second).toEqual({ notModified: true });
    expect(requests.at(-1)?.headers).toMatchObject({
      "if-none-match": '"v1"',
      "if-modified-since": "Mon, 02 Nov 2026 00:00:00 GMT",
    });
  });

  it("names Watchdog and its version in the User-Agent", async () => {
    await fetchFeed(`${base}/fixtures/hnrss.rss`, {}, deps);
    expect(requests.at(-1)?.headers["user-agent"]).toMatch(
      /^Watchdog\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/hrustalq\/watchdog\)$/,
    );
  });

  it("fetches through the egress guard", async () => {
    await expect(fetchFeed("http://blocked.test/feed.rss", {}, deps)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });
});
