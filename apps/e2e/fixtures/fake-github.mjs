// The smoke run's GitHub (compose.smoke.yaml). Watchdog calls two fixed hosts: github.com for a repo's
// releases.atom, which the RSS parser reads, and api.github.com for the REST and Search APIs that issues
// and mentions Sources use. The fixtures container answers both with TLS and passes the requests here,
// so the real GitHub code runs and no request leaves the Compose network.
//
// Everything is computed per request, so the dates stay inside the run's 7-day Backfill window. The
// repo is `acme/app`, which the test adds; a mentions Source searches for `flipboard` in it.
import { createServer } from "node:http";
import { json } from "node:stream/consumers";

const repo = "acme/app";
const api = "https://api.github.com";
const site = "https://github.com";

/** An ISO timestamp `minutesAgo` before now. */
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** The releases the feed lists, newest first: two inside the Backfill window and one outside it. */
const releases = [
  {
    tag: "v2.4.0",
    title: "Acme app v2.4.0",
    minutesAgo: 120,
    body: "<p>A faster planner and a fix for the export button.</p>",
  },
  {
    tag: "v2.3.1",
    title: "Acme app v2.3.1",
    minutesAgo: 60 * 24 * 3,
    body: "<p>Patch release for the dashboard.</p>",
  },
  {
    tag: "v2.3.0",
    title: "Acme app v2.3.0",
    minutesAgo: 60 * 24 * 30,
    body: "<p>An older release, outside the Backfill's 7 days.</p>",
  },
];

/** The repo's releases.atom, in the shape GitHub serves it: an Atom feed of release tags. */
function releasesAtom() {
  const entries = releases
    .map(
      ({ tag, title, minutesAgo, body }) => `  <entry>
    <id>tag:github.com,2008:Repository/1/${tag}</id>
    <updated>${iso(minutesAgo)}</updated>
    <link rel="alternate" type="text/html" href="${site}/${repo}/releases/tag/${tag}"/>
    <title>${title}</title>
    <content type="html">${body.replaceAll("<", "&lt;")}</content>
    <author>
      <name>acme-ci</name>
    </author>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">
  <id>tag:github.com,2008:https://github.com/${repo}/releases</id>
  <link type="text/html" rel="alternate" href="${site}/${repo}/releases"/>
  <link type="application/atom+xml" rel="self" href="${site}/${repo}/releases.atom"/>
  <title>Release notes from app</title>
  <updated>${iso(0)}</updated>
${entries}
</feed>
`;
}

/** One issue, as the issues and Search APIs return it. */
const issue = ({ number, title, minutesAgo, body }) => ({
  number,
  title,
  body,
  html_url: `${site}/${repo}/issues/${String(number)}`,
  user: { login: "acme-dev" },
  created_at: iso(minutesAgo),
  updated_at: iso(minutesAgo),
  state: "open",
});

/** The issues endpoint lists pull requests too, and Watchdog drops them. */
const issues = [
  issue({ number: 42, title: "Export button loses the header row", minutesAgo: 30, body: "Steps to reproduce below." }),
  issue({ number: 41, title: "Support weekly digests", minutesAgo: 60, body: "It would help to get one summary a week." }),
  {
    ...issue({ number: 40, title: "Fix the dashboard charts", minutesAgo: 90, body: "A pull request, not an issue." }),
    pull_request: { url: `${api}/repos/${repo}/pulls/40` },
  },
];

/** The Search API's answer for the mentions Source's term. */
const results = [
  issue({ number: 39, title: "flipboard layout breaks on narrow screens", minutesAgo: 45, body: "Seen in Safari." }),
  issue({ number: 38, title: "Ask for flipboard in the digest", minutesAgo: 75, body: "A feature request." }),
];

const routes = [
  // The releases feed, fetched by the host Watchdog builds the URL from.
  {
    host: "github.com",
    path: new RegExp(`^/${repo}/releases\\.atom$`),
    answer: (response) => {
      response.writeHead(200, { "content-type": "application/atom+xml; charset=utf-8" });
      response.end(releasesAtom());
    },
  },
  // The first poll of an issues Source: the newest issues created, newest first.
  {
    host: "api.github.com",
    path: new RegExp(`^/repos/${repo}/issues$`),
    answer: (response) => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", etag: '"smoke-issues"' });
      response.end(JSON.stringify(issues));
    },
  },
  // A mentions Source's search, which answers an object with the results in `items`.
  {
    host: "api.github.com",
    path: /^\/search\/issues$/,
    answer: (response) => {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ total_count: results.length, incomplete_results: false, items: results }));
    },
  },
];

function notFound(response) {
  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ message: "Not Found" }));
}

createServer((request, response) => {
  const host = request.headers.host?.split(":")[0];
  // Only the issues and search routes carry a query string, and neither handler reads it.
  const pathname = (request.url ?? "/").split("?")[0];
  // The healthcheck and the test's read of what this answered so far.
  if (request.method === "GET" && pathname === "/") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ releases: releases.length, issues: issues.length, results: results.length }));
    return;
  }
  const route = routes.find((candidate) => candidate.host === host && candidate.path.test(pathname));
  if (route === undefined) {
    // A POST elsewhere would need the body read before answering; nothing here takes one.
    void json(request).catch(() => undefined);
    notFound(response);
    return;
  }
  route.answer(response);
}).listen(8080);
