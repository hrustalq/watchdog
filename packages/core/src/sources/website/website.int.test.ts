import { readFileSync } from "node:fs";
import { closeDb, createDb, type Db, eq, item, migrate, source, user, workspace } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pollSource, type PollSourceDeps } from "../../pipeline/capture.ts";

// Hand-made pages (docs: Testing and CI, "no live HTTP"): a pricing page, the same page after the Pro
// plan's price and support changed and its visitor counter moved, and a robots.txt whose Watchdog
// group disallows the pricing page while its `*` group allows it.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const v1 = fixture("pricing-v1.html");
const v2 = fixture("pricing-v2.html");
const robotsDisallow = fixture("robots-disallow.txt");
const html = { "content-type": "text/html; charset=utf-8" };
const pageRaw = z.object({ text: z.string(), html: z.string() });

const now = new Date("2026-11-09T12:00:00Z");
const hour = 60 * 60 * 1000;

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

/** No live HTTP: `respond` answers each request by URL, and every URL asked for is kept. */
function site(respond: (url: string) => Response | undefined, mode: "hosted" | "self-hosted" = "hosted") {
  const asked: string[] = [];
  let at = now;
  const deps: PollSourceDeps = {
    fetch: (input) => {
      const url = String(input);
      asked.push(url);
      const response = respond(url);
      return response ? Promise.resolve(response) : Promise.reject(new Error("connect ECONNREFUSED"));
    },
    now: () => at,
    enqueueItems: () => Promise.resolve(),
    secrets: { encryptionKey: Buffer.alloc(32), authSecret: "unused-by-website-sources" },
    mode,
  };
  return { asked, deps, later: (ms: number) => (at = new Date(at.getTime() + ms)) };
}

/** A site whose robots.txt is missing (404, which allows everything) and whose page is `page()`. */
function page(origin: string, body: () => string, mode?: "hosted" | "self-hosted") {
  return site(
    (url) =>
      url === `${origin}/robots.txt`
        ? new Response("Not found", { status: 404 })
        : new Response(body(), { headers: html }),
    mode,
  );
}

describe("website Sources", () => {
  let postgres: TestPostgres;
  let db: Db;
  let workspaceId: string;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: "owner" }).returning();
    workspaceId = present(ws).id;
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** A website Source on its own origin, so robots.txt caching can't leak between tests. */
  async function newSource(config: { region?: string; ignore?: string[]; ignoreRobots?: true } = {}) {
    const origin = `https://${crypto.randomUUID()}.pages.test`;
    const url = `${origin}/pricing`;
    const [created] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "website",
        name: "Acme pricing",
        config: { url, ignore: [], render: "static", ...config },
        schedule: "*/15 * * * *",
      })
      .returning();
    return { ...present(created), origin, url };
  }

  const itemsOf = (sourceId: string) =>
    db.query.item.findMany({ where: eq(item.sourceId, sourceId), with: { log: true } });
  const reload = async (sourceId: string) =>
    present(await db.query.source.findFirst({ where: eq(source.id, sourceId) }));

  it("stores the first fetch as the Baseline, and captures a change as one Item", async () => {
    const src = await newSource();
    let body = v1;
    const { deps, later } = page(src.origin, () => body);

    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 0 });
    expect(await itemsOf(src.id)).toEqual([]);
    const baseline = await reload(src.id);
    expect(baseline.lastError).toBeNull();
    expect(baseline.fetchState.hash).toMatch(/^[0-9a-f]{64}$/);
    // Scripts, styles and markup don't count; the page's text does, a line per block.
    expect(baseline.fetchState.text).toContain("Pro\n$20 / month\nUnlimited projects\nEmail support");
    expect(baseline.fetchState.text).not.toContain("analytics");

    // The same page again is no change.
    later(hour);
    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 0 });

    body = v2;
    later(hour);
    const changedAt = new Date(now.getTime() + 2 * hour);
    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 1 });
    const [changed, ...others] = await itemsOf(src.id);
    expect(others).toEqual([]);
    const captured = present(changed);
    expect(captured.title).toBe("Acme & Co pricing changed");
    expect(captured.url).toBe(src.url);
    expect(captured.publishedAt).toEqual(changedAt);
    expect(captured.body).toBe(
      // "Email support" and the visitor counter are adjacent lines, so they change as one run.
      ["- $20 / month", "+ $25 / month", "- Email support", "- 1204 visitors today", "+ Priority support", "+ 1377 visitors today"].join("\n"),
    );
    const after = await reload(src.id);
    expect(captured.externalId).toBe(`${after.fetchState.hash ?? ""}:${changedAt.toISOString()}`);
    expect(after.fetchState.hash).not.toBe(baseline.fetchState.hash);
    const raw = pageRaw.parse(captured.raw);
    expect(raw.text).toBe(after.fetchState.text);
    expect(raw.html).toMatch(/^<body>/);
    expect(raw.html).toContain('<p class="price">$25 / month</p>');
    expect(captured.log).toHaveLength(1);
    expect(present(captured.log[0]).message).toBe("Captured from Acme pricing");

    // The new page is now the Baseline.
    later(hour);
    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 0 });
  });

  it("ignores a change that only an ignore pattern covers", async () => {
    const src = await newSource({ ignore: [String.raw`\d+ visitors`] });
    let body = v1;
    const { deps } = page(src.origin, () => body);
    await pollSource(db, src.id, deps);
    expect((await reload(src.id)).fetchState.text).toContain("\ntoday\n");

    body = v1.replace("1204 visitors", "1377 visitors");
    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 0 });
    expect(await itemsOf(src.id)).toEqual([]);

    // A change outside it still counts.
    body = v2;
    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 1 });
  });

  it("keeps only the Region's HTML and text", async () => {
    const src = await newSource({ region: "#pricing .plan" });
    let body = v1;
    const { deps } = page(src.origin, () => body);
    await pollSource(db, src.id, deps);
    body = v2;
    await pollSource(db, src.id, deps);

    const captured = present((await itemsOf(src.id))[0]);
    const raw = pageRaw.parse(captured.raw);
    // Both matches, in document order, and nothing outside them.
    expect(raw.html).toMatch(/^<section class="plan">\s*<h2>Starter<\/h2>[\s\S]*<h2>Pro<\/h2>[\s\S]*<\/section>$/);
    expect(raw.html).not.toContain("<nav>");
    expect(raw.html).not.toContain("visitors");
    expect(raw.text).toBe(["Starter", "$0 / month", "3 projects", "Community support", "Pro", "$25 / month", "Unlimited projects", "Priority support"].join("\n"));
    expect(captured.body).not.toContain("visitors");
  });

  it("captures a page over 1 MB of HTML with its text but without the HTML, and says so", async () => {
    const src = await newSource();
    let body = v1;
    const { deps } = page(src.origin, () => body);
    await pollSource(db, src.id, deps);

    // About 1.2 MB of markup around the changed price.
    const padding = `<div class="row"><span class="cell">a</span></div>`.repeat(24_000);
    body = v2.replace("</main>", `<div>${padding}</div></main>`);
    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 1 });

    const captured = present((await itemsOf(src.id))[0]);
    expect(captured.raw).not.toHaveProperty("html");
    expect(captured.raw).toHaveProperty("text");
    expect(captured.body).toContain("+ $25 / month");
    expect(present(captured.log[0]).message).toBe(
      "Captured from Acme pricing. The page HTML was too large to keep: it is over 1 MB.",
    );
    expect((await reload(src.id)).lastError).toBeNull();
  });

  it("fails a poll whose Region matches nothing, or whose answer isn't HTML", async () => {
    const regionless = await newSource({ region: ".pricing-table" });
    await pollSource(db, regionless.id, page(regionless.origin, () => v1).deps);
    expect((await reload(regionless.id)).lastError).toBe("The region .pricing-table matched nothing on the page");

    const pdf = await newSource();
    const { deps } = site((url) =>
      url.endsWith("/robots.txt")
        ? new Response("", { status: 404 })
        : new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } }),
    );
    await pollSource(db, pdf.id, deps);
    expect((await reload(pdf.id)).lastError).toBe(`${pdf.url} answered with application/pdf, not an HTML page`);
    expect((await reload(pdf.id)).fetchState).toEqual({});
  });

  it("refuses on hosted a page that robots.txt disallows for Watchdog, without fetching it", async () => {
    const src = await newSource();
    const { asked, deps } = site((url) =>
      url === `${src.origin}/robots.txt` ? new Response(robotsDisallow) : new Response(v1, { headers: html }),
    );
    expect(await pollSource(db, src.id, deps)).toEqual({
      error: `${src.origin}/robots.txt disallows Watchdog from fetching this page`,
    });
    expect(asked).toEqual([`${src.origin}/robots.txt`]);
    expect((await reload(src.id)).lastError).toBe(`${src.origin}/robots.txt disallows Watchdog from fetching this page`);
  });

  it("checks robots.txt on self-hosted unless the Source turns it off, and never lets hosted turn it off", async () => {
    const answer = (origin: string) => (url: string) =>
      url === `${origin}/robots.txt` ? new Response(robotsDisallow) : new Response(v1, { headers: html });

    const checked = await newSource();
    await pollSource(db, checked.id, site(answer(checked.origin), "self-hosted").deps);
    expect((await reload(checked.id)).lastError).toMatch(/robots\.txt disallows/);

    const ignored = await newSource({ ignoreRobots: true });
    const selfHosted = site(answer(ignored.origin), "self-hosted");
    expect(await pollSource(db, ignored.id, selfHosted.deps)).toEqual({ captured: 0 });
    expect(selfHosted.asked).toEqual([ignored.url]);

    const onHosted = await newSource({ ignoreRobots: true });
    await pollSource(db, onHosted.id, site(answer(onHosted.origin), "hosted").deps);
    expect((await reload(onHosted.id)).lastError).toMatch(/robots\.txt disallows/);
  });

  it("caches robots.txt per origin for 24 hours, but not an answer it couldn't use", async () => {
    const src = await newSource();
    let robots = () => new Response("Unavailable", { status: 503 });
    const { asked, deps, later } = site((url) =>
      url === `${src.origin}/robots.txt` ? robots() : new Response(v1, { headers: html }),
    );
    const robotsAsked = () => asked.filter((url) => url.endsWith("/robots.txt")).length;

    // A 5xx disallows that poll, and the next one asks again.
    await pollSource(db, src.id, deps);
    expect((await reload(src.id)).lastError).toBe(
      `${src.origin}/robots.txt answered 503, so Watchdog didn't fetch the page. The next poll tries again.`,
    );
    robots = () => new Response("User-agent: *\nDisallow: /drafts/\n");
    expect(await pollSource(db, src.id, deps)).toEqual({ captured: 0 });
    expect(robotsAsked()).toBe(2);

    later(23 * hour);
    await pollSource(db, src.id, deps);
    expect(robotsAsked()).toBe(2);
    later(2 * hour);
    await pollSource(db, src.id, deps);
    expect(robotsAsked()).toBe(3);
    expect((await reload(src.id)).lastError).toBeNull();
  });
});
