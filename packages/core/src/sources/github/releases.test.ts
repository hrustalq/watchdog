import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PollDeps } from "../types.ts";
import { github, parseRepo, releasesFeedUrl } from "./releases.ts";

// Recorded from github.com on 2026-11-08: vercel/next.js's releases.atom trimmed to its first three
// entries, and the body GitHub sends with its 404 for a repo that doesn't exist (text/plain).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

/** A fetch that answers each URL from `responses` and records what was asked. */
function serving(responses: Record<string, () => Response>) {
  const asked: string[] = [];
  const deps: PollDeps = {
    fetch: (input) => {
      asked.push(String(input));
      const respond = responses[String(input)];
      return respond ? Promise.resolve(respond()) : Promise.reject(new Error("connect ECONNREFUSED"));
    },
  };
  return { asked, deps };
}

describe("parseRepo", () => {
  it.each([
    ["vercel/next.js", "vercel/next.js"],
    ["  vercel/next.js  ", "vercel/next.js"],
    ["https://github.com/vercel/next.js", "vercel/next.js"],
    ["https://www.github.com/vercel/next.js/", "vercel/next.js"],
    ["http://GitHub.com/vercel/next.js/releases?page=2", "vercel/next.js"],
    ["github.com/vercel/next.js.git", "vercel/next.js"],
    ["https://github.com/octo-org/my_repo#readme", "octo-org/my_repo"],
  ])("reads %j as %j", (input, repo) => {
    expect(parseRepo(input)).toBe(repo);
  });

  it.each([
    "",
    "vercel",
    "https://github.com/vercel",
    "https://gitlab.com/vercel/next.js",
    "-vercel/next.js",
    "vercel/..",
    "ver cel/next.js",
    "vercel/next js",
    `${"a".repeat(40)}/next.js`,
  ])("refuses %j", (input) => {
    expect(parseRepo(input)).toBeNull();
  });
});

describe("a GitHub releases Source", () => {
  const repo = "vercel/next.js";
  const url = "https://github.com/vercel/next.js/releases.atom";

  it("polls the repo's releases.atom and gives each release its Atom id", async () => {
    const atom = fixture("vercel-next.js-releases.atom");
    const { asked, deps } = serving({
      [url]: () => new Response(atom, { headers: { "content-type": "application/atom+xml", etag: 'W/"e7f5"' } }),
    });

    const polled = await github.poll?.({ config: { kind: "releases", repo }, fetchState: {} }, deps);

    expect(releasesFeedUrl(repo)).toBe(url);
    expect(asked).toEqual([url]);
    if (polled === undefined || "notModified" in polled) throw new Error("Expected drafts");
    expect(polled.fetchState).toEqual({ etag: 'W/"e7f5"' });
    expect(polled.drafts.map((draft) => draft.externalId)).toEqual([
      "tag:github.com,2008:Repository/70107786/v16.5.0-canary.45",
      "tag:github.com,2008:Repository/70107786/v16.5.0-canary.44",
      "tag:github.com,2008:Repository/70107786/v16.5.0-canary.43",
    ]);
    expect(polled.drafts[0]).toMatchObject({
      title: "v16.5.0-canary.45",
      url: "https://github.com/vercel/next.js/releases/tag/v16.5.0-canary.45",
      publishedAt: new Date("2026-11-08T23:47:13Z"),
    });
  });

  it("says a missing or private repo plainly instead of quoting the HTTP error", async () => {
    const { deps } = serving({
      [url]: () =>
        new Response(fixture("missing-repo-releases.txt"), {
          status: 404,
          statusText: "Not Found",
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    });

    await expect(
      github.poll?.({ config: { kind: "releases", repo }, fetchState: {} }, deps),
    ).rejects.toThrow(
      "GitHub has no public repo vercel/next.js. It may have been renamed, deleted or made private.",
    );
  });

  it("passes on any other HTTP error as it came", async () => {
    const { deps } = serving({ [url]: () => new Response("", { status: 503, statusText: "Service Unavailable" }) });

    await expect(
      github.poll?.({ config: { kind: "releases", repo }, fetchState: {} }, deps),
    ).rejects.toThrow(`${url} answered 503 Service Unavailable`);
  });

  it("takes the RSS Backfill: 7 days, at most 50 Items", () => {
    expect(github.backfill).toEqual({ window: 7 * 24 * 60 * 60 * 1000, max: 50 });
  });
});
