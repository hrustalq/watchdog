import { readFileSync } from "node:fs";
import { account, closeDb, createDb, type Db, eq, item, migrate, source, user, workspace } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { symmetricEncrypt } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { pollSource, type PollSourceDeps } from "../../pipeline/capture.ts";
import { encryptSecret } from "../../secrets/secrets.ts";

// Recorded from api.github.com on 2026-11-09 around 10:44 UTC (docs: Testing and CI, "no live HTTP"):
// two pages of microsoft/vscode's issues updated since 08:44:32, whose second page's next link is
// cut so the run ends there; the 304 for the first page's ETag; the 401 for a revoked token; a
// Search API page for "hydration mismatch" in vercel/next.js; and the 403 an anonymous client gets
// past the Search limit, with its IP replaced by a documentation address.
const recording = z.object({ status: z.number(), headers: z.record(z.string(), z.string()), body: z.unknown() });
type Recorded = z.infer<typeof recording>;
const recorded = (name: string) =>
  recording.parse(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")));
const answer = ({ status, headers, body }: Recorded, extra: Record<string, string> = {}) =>
  new Response(status === 304 ? null : JSON.stringify(body), { status, headers: { ...headers, ...extra } });

const page1 = recorded("issues-200-page-1");
const page2 = recorded("issues-200-page-2");
const notModified = recorded("issues-304");
const refused = recorded("issues-401");
const search = recorded("search-200");
const searchLimited = recorded("search-403-rate-limited");

const recordedAt = new Date("2026-11-09T10:44:40Z");
const api = "https://api.github.com";
const page2Url = /<([^>]+)>; rel="next"/.exec(page1.headers.link ?? "")?.[1] ?? "";

interface Asked {
  url: string;
  headers: Headers;
}

/** No live HTTP: `respond` answers each request, and every request is kept. */
function github(now: Date, respond: (asked: Asked) => Response | undefined) {
  const asked: Asked[] = [];
  const deps: PollSourceDeps = {
    fetch: (input, init) => {
      const request = { url: String(input), headers: new Headers(init?.headers) };
      asked.push(request);
      const response = respond(request);
      return response ? Promise.resolve(response) : Promise.reject(new Error("connect ECONNREFUSED"));
    },
    now: () => now,
    enqueueItems: () => Promise.resolve(),
    secrets,
  };
  return { asked, deps };
}

const secrets = { encryptionKey: Buffer.alloc(32, 9), authSecret: "a-better-auth-secret-of-32-chars!" };
const issuesUrl = (repo: string, since: string) =>
  `${api}/repos/${repo}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(since)}&per_page=100`;

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

describe("GitHub issues and mentions Sources", () => {
  let postgres: TestPostgres;
  let db: Db;
  let tokenless: string;

  beforeAll(async () => {
    postgres = await startPostgres();
    await migrate(postgres.url);
    db = createDb(postgres.url);
    tokenless = await newWorkspace();
    return async () => {
      await closeDb(db);
      await postgres.stop();
    };
  }, 120_000);

  /** A Workspace whose owner signed in with GitHub when `signInToken` is given, as Better Auth stores it. */
  async function newWorkspace(signInToken?: string) {
    const userId = crypto.randomUUID();
    await db.insert(user).values({ id: userId, name: "Owner", email: `${userId}@example.com` });
    if (signInToken !== undefined) {
      await db.insert(account).values({
        id: crypto.randomUUID(),
        accountId: "583231",
        providerId: "github",
        userId,
        accessToken: signInToken,
      });
    }
    const [created] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: userId }).returning();
    return present(created).id;
  }

  async function newSource(
    workspaceId: string,
    config: { kind: "issues"; repo: string } | { kind: "mentions"; term: string; within?: string },
    pastedToken?: string,
  ) {
    const [created] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "github",
        name: "GitHub",
        config,
        schedule: "*/15 * * * *",
        ...(pastedToken !== undefined && { secretCiphertext: encryptSecret(pastedToken, secrets.encryptionKey) }),
      })
      .returning();
    return present(created);
  }

  const reload = async (id: string) => present(await db.query.source.findFirst({ where: eq(source.id, id) }));
  const capturedIds = async (id: string) =>
    (await db.select({ externalId: item.externalId }).from(item).where(eq(item.sourceId, id)))
      .map((row) => row.externalId)
      .sort();

  describe("issues", () => {
    it("captures new issues, not PRs, from every page, and a second poll's 304 inserts nothing", async () => {
      const ws = await newWorkspace();
      const src = await newSource(ws, { kind: "issues", repo: "microsoft/vscode" }, "github_pat_issues");
      const since = new Date(recordedAt.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const first = github(recordedAt, ({ url }) => {
        if (url === issuesUrl("microsoft/vscode", since)) return answer(page1);
        return url === page2Url ? answer(page2) : undefined;
      });

      expect(await pollSource(db, src.id, first.deps)).toEqual({ captured: 2 });

      // The Backfill keeps issues created in the 7 days before the poll: older issues that were
      // only edited lately, and the PRs, stay out.
      expect(await capturedIds(src.id)).toEqual(["345911", "346911"]);
      expect(first.asked.map((request) => request.url)).toEqual([issuesUrl("microsoft/vscode", since), page2Url]);
      for (const { headers } of first.asked) {
        expect(headers.get("authorization")).toBe("Bearer github_pat_issues");
        expect(headers.get("x-github-api-version")).toBe("2022-11-28");
        expect(headers.get("accept")).toBe("application/vnd.github+json");
      }
      const [captured] = await db.select().from(item).where(eq(item.externalId, "346911"));
      expect(captured).toMatchObject({
        url: "https://github.com/microsoft/vscode/issues/346911",
        title: "Switching back to `required` did not block sending in the existing chat",
        author: "chrmarti",
        publishedAt: new Date("2026-11-09T08:44:49Z"),
        isBackfill: true,
      });
      const afterFirst = await reload(src.id);
      expect(afterFirst.fetchState).toEqual({ since: "2026-11-09T08:53:52Z", etag: page1.headers.etag });

      const second = github(recordedAt, ({ url, headers }) =>
        url === issuesUrl("microsoft/vscode", "2026-11-09T08:53:52Z") &&
        headers.get("if-none-match") === page1.headers.etag
          ? answer(notModified)
          : undefined,
      );
      expect(await pollSource(db, src.id, second.deps)).toEqual({ captured: 0 });
      expect(second.asked).toHaveLength(1);
      expect(second.asked.some((request) => request.url.startsWith(`${api}/search/`))).toBe(false);
      expect(await capturedIds(src.id)).toEqual(["345911", "346911"]);
      expect(await reload(src.id)).toMatchObject({ lastError: null, fetchState: afterFirst.fetchState });
    });

    it("never captures an edited issue again", async () => {
      const ws = await newWorkspace();
      const src = await newSource(ws, { kind: "issues", repo: "microsoft/vscode" }, "github_pat_edits");
      const both = github(recordedAt, ({ url }) => (url === page2Url ? answer(page2) : answer(page1)));
      await pollSource(db, src.id, both.deps);

      // The same issues come back with a new updated_at.
      expect(await pollSource(db, src.id, both.deps)).toEqual({ captured: 0 });
      expect(await capturedIds(src.id)).toEqual(["345911", "346911"]);
    });

    it("says to paste a new token when GitHub refuses a pasted one", async () => {
      const ws = await newWorkspace("gho_signin");
      const src = await newSource(ws, { kind: "issues", repo: "microsoft/vscode" }, "github_pat_revoked");
      const { deps } = github(recordedAt, () => answer(refused));

      const message = "GitHub refused the token. Paste a new one on this Source.";
      expect(await pollSource(db, src.id, deps)).toEqual({ error: message });
      expect(await reload(src.id)).toMatchObject({ lastError: message, lastPolledAt: null });
    });

    it("says to sign in again when GitHub refuses the sign-in token", async () => {
      const ws = await newWorkspace("gho_revoked");
      const src = await newSource(ws, { kind: "issues", repo: "microsoft/vscode" });
      const { deps } = github(recordedAt, () => answer(refused));

      expect(await pollSource(db, src.id, deps)).toEqual({
        error: "GitHub refused the sign-in token. Sign in with GitHub again, or paste a token on this Source.",
      });
    });
  });

  describe("the token", () => {
    const tokenSent = async (workspaceId: string, pasted?: string) => {
      const src = await newSource(workspaceId, { kind: "issues", repo: "microsoft/vscode" }, pasted);
      const { asked, deps } = github(recordedAt, () => answer(notModified));
      await pollSource(db, src.id, deps);
      return asked[0]?.headers.get("authorization");
    };

    it("prefers the pasted token over the sign-in token", async () => {
      const ws = await newWorkspace("gho_signin_unused");
      expect(await tokenSent(ws, "github_pat_chosen")).toBe("Bearer github_pat_chosen");
    });

    it("uses the sign-in token Better Auth encrypted, or one stored before encryption", async () => {
      const encrypted = await symmetricEncrypt({ key: secrets.authSecret, data: "gho_encrypted" });
      expect(await tokenSent(await newWorkspace(encrypted))).toBe("Bearer gho_encrypted");
      expect(await tokenSent(await newWorkspace("gho_plain"))).toBe("Bearer gho_plain");
    });

    it("fails the poll without a request when there's neither token", async () => {
      const src = await newSource(tokenless, { kind: "mentions", term: "watchdog" });
      const { asked, deps } = github(recordedAt, () => answer(search));

      expect(await pollSource(db, src.id, deps)).toEqual({
        error: "This Source has no GitHub token. Sign in with GitHub, or paste a token on this Source.",
      });
      expect(asked).toEqual([]);
    });
  });

  describe("mentions", () => {
    const term = "hydration mismatch";
    const within = "repo:vercel/next.js";
    const searchUrl =
      `${api}/search/issues?` +
      new URLSearchParams({
        q: `${term} (is:issue OR is:pr) ${within}`,
        sort: "created",
        order: "desc",
        per_page: "100",
        advanced_search: "true",
      }).toString();

    it("captures matching issues and PRs once each, keyed by their URL", async () => {
      // Late enough that the recorded results from 2026-10-14 on fall inside the Backfill window.
      const now = new Date("2026-10-21T00:00:00Z");
      const ws = await newWorkspace("gho_mentions");
      const src = await newSource(ws, { kind: "mentions", term, within });
      const { asked, deps } = github(now, ({ url }) => (url === searchUrl ? answer(search) : undefined));

      expect(await pollSource(db, src.id, deps)).toEqual({ captured: 4 });
      expect(await capturedIds(src.id)).toEqual([
        "https://github.com/vercel/next.js/issues/100293",
        "https://github.com/vercel/next.js/issues/100386",
        "https://github.com/vercel/next.js/pull/100276",
        "https://github.com/vercel/next.js/pull/101221",
      ]);
      expect(asked[0]?.headers.get("authorization")).toBe("Bearer gho_mentions");

      expect(await pollSource(db, src.id, deps)).toEqual({ captured: 0 });
      expect(await capturedIds(src.id)).toHaveLength(4);
    });

    it("keeps one token's Search calls under 30 a minute across its Sources", async () => {
      const ws = await newWorkspace();
      const pasted = "github_pat_budget";
      const sources = await Promise.all(
        Array.from({ length: 31 }, (_, i) => newSource(ws, { kind: "mentions", term: `term ${String(i)}` }, pasted)),
      );
      const now = new Date("2026-11-09T10:44:40Z");
      const { asked, deps } = github(now, () => answer(search));

      // Each takes the one recorded result created inside its Backfill window.
      for (const src of sources.slice(0, 30)) expect(await pollSource(db, src.id, deps)).toEqual({ captured: 1 });
      const last = present(sources[30]);
      await db.update(source).set({ nextPollAt: now }).where(eq(source.id, last.id));
      expect(await pollSource(db, last.id, deps)).toEqual({ deferredUntil: new Date("2026-11-09T10:45:00Z") });

      expect(asked).toHaveLength(30);
      expect(await reload(last.id)).toMatchObject({
        nextPollAt: new Date("2026-11-09T10:45:00Z"),
        lastError: null,
        consecutiveFailures: 0,
      });
    });
  });

  describe("rate limits", () => {
    it("moves next_poll_at past the reset on a rate-limited answer instead of recording a failure", async () => {
      const ws = await newWorkspace();
      const pasted = "github_pat_limited";
      const src = await newSource(ws, { kind: "mentions", term: "watchdog" }, pasted);
      const reset = new Date(Number(searchLimited.headers["x-ratelimit-reset"]) * 1000);
      // When the 403 was recorded, 53 seconds before its reset.
      const limited = github(new Date("2026-11-09T10:43:41Z"), () => answer(searchLimited));

      const result = await pollSource(db, src.id, limited.deps);

      expect(result).toEqual({ deferredUntil: new Date(reset.getTime() + 1000) });
      const after = await reload(src.id);
      expect(after.nextPollAt?.getTime()).toBeGreaterThan(reset.getTime());
      expect(after).toMatchObject({ lastError: null, lastErrorAt: null, consecutiveFailures: 0 });

      // Another Source with the same token waits too, without asking GitHub.
      const sibling = await newSource(ws, { kind: "mentions", term: "watchdog alerts" }, pasted);
      const waiting = github(new Date(reset.getTime() - 5000), () => answer(search));
      expect(await pollSource(db, sibling.id, waiting.deps)).toEqual({ deferredUntil: new Date(reset.getTime() + 1000) });
      expect(waiting.asked).toEqual([]);
    });

    it("waits out a retry-after", async () => {
      const ws = await newWorkspace("gho_retry_after");
      const src = await newSource(ws, { kind: "issues", repo: "microsoft/vscode" });
      const { deps } = github(recordedAt, () =>
        answer({ status: 429, headers: { "retry-after": "120" }, body: { message: "secondary rate limit" } }),
      );

      expect(await pollSource(db, src.id, deps)).toEqual({
        deferredUntil: new Date(recordedAt.getTime() + 120_000),
      });
      expect((await reload(src.id)).lastError).toBeNull();
    });
  });
});
