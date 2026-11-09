// What GitHub's issues and mentions kinds share: the token, the API headers and the rate limits
// (docs: Sources and ingestion, "The token" and "Rate limits").
import { createHash } from "node:crypto";
import { account, and, type Db, eq, githubRateLimit, sql, workspace } from "@watchdog/db";
import { symmetricDecrypt } from "better-auth/crypto";
import { decryptSecret } from "../../secrets/secrets.ts";
import type { FetchFeedDeps } from "../rss/fetch-feed.ts";

export const githubApi = "https://api.github.com";

export interface GithubSecrets {
  /** WATCHDOG_ENCRYPTION_KEY, which a pasted token is encrypted with. */
  encryptionKey: Buffer;
  /** BETTER_AUTH_SECRET, which Better Auth encrypts the sign-in token with. */
  authSecret: string;
}

export interface GithubToken {
  value: string;
  /** Pasted on the Source's form, rather than the owner's GitHub sign-in token. */
  pasted: boolean;
}

/**
 * The Source's pasted token, or else the GitHub sign-in token of its Workspace's owner. Throws when
 * there's neither.
 */
export async function githubToken(
  db: Db,
  owner: { workspaceId: string; secretCiphertext: string | null },
  secrets: GithubSecrets,
): Promise<GithubToken> {
  if (owner.secretCiphertext !== null) {
    return { value: decryptSecret(owner.secretCiphertext, secrets.encryptionKey), pasted: true };
  }
  const stored = await signInToken(db, owner.workspaceId);
  if (stored === undefined) {
    throw new Error("This Source has no GitHub token. Sign in with GitHub, or paste a token on this Source.");
  }
  // Better Auth encrypts it as hex (or a "$ba$" envelope) once encryptOAuthTokens is on; a token
  // stored before that is still plain, and a GitHub token is never hex.
  const encrypted = stored.startsWith("$ba$") || /^(?:[\da-f]{2})+$/i.test(stored);
  const value = encrypted ? await symmetricDecrypt({ key: secrets.authSecret, data: stored }) : stored;
  return { value, pasted: false };
}

/** The GitHub access token Better Auth stored when the Workspace's owner signed in with GitHub. */
export async function signInToken(db: Db, workspaceId: string) {
  const [row] = await db
    .select({ accessToken: account.accessToken })
    .from(account)
    .innerJoin(workspace, eq(workspace.ownerUserId, account.userId))
    .where(and(eq(workspace.id, workspaceId), eq(account.providerId, "github")))
    .limit(1);
  return row?.accessToken ?? undefined;
}

/** GitHub refused the token: revoked, expired or mistyped. */
export class GithubTokenError extends Error {
  override name = "GithubTokenError";
  constructor(pasted: boolean) {
    super(
      pasted
        ? "GitHub refused the token. Paste a new one on this Source."
        : "GitHub refused the sign-in token. Sign in with GitHub again, or paste a token on this Source.",
    );
  }
}

/** GitHub answered with an error status other than a refused token or a rate limit. */
export class GithubHttpError extends Error {
  override name = "GithubHttpError";
  readonly status: number;
  constructor(status: number, message: string) {
    super(`GitHub answered ${String(status)}${message === "" ? "" : `: ${message}`}`);
    this.status = status;
  }
}

/** A request put off by the token's rate limit, until the time GitHub allows it again. */
export interface Deferred {
  deferUntil: Date;
}

/** The egress guard's Response, which is undici's rather than the DOM's. */
export type GithubResponse = Awaited<ReturnType<FetchFeedDeps["fetch"]>>;

export interface GithubGetDeps extends FetchFeedDeps {
  db: Db;
  now: Date;
}

/** GitHub allows each token 30 Search requests a minute. */
const searchPerMinute = 30;

/**
 * GETs a GitHub API URL with the token, unless the token's limits for `resource` put it off. An
 * answer with none remaining, or with a `retry-after`, puts off the token's later requests too.
 * Answers a 2xx or a 304; throws GithubTokenError on a 401 and GithubHttpError on another error.
 */
export async function githubGet(
  url: string,
  { token, resource, etag }: { token: GithubToken; resource: "core" | "search"; etag?: string | undefined },
  { db, fetch, now }: GithubGetDeps,
): Promise<GithubResponse | Deferred> {
  const tokenHash = createHash("sha256").update(token.value).digest("hex");
  const key = and(eq(githubRateLimit.tokenHash, tokenHash), eq(githubRateLimit.resource, resource));
  const [limit] = await db.select().from(githubRateLimit).where(key);
  if (limit?.pausedUntil && limit.pausedUntil > now) return { deferUntil: limit.pausedUntil };

  if (resource === "search") {
    // One row per token counts its calls in the current minute, so concurrent polls on several
    // workers take turns at the row and can't both take the last call.
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const [counted] = await db
      .insert(githubRateLimit)
      .values({ tokenHash, resource, windowStart: minute, windowCalls: 1 })
      .onConflictDoUpdate({
        target: [githubRateLimit.tokenHash, githubRateLimit.resource],
        set: {
          windowCalls: sql`case when ${githubRateLimit.windowStart} = ${minute.toISOString()}::timestamptz
            then ${githubRateLimit.windowCalls} + 1 else 1 end`,
          windowStart: minute,
        },
      })
      .returning({ calls: githubRateLimit.windowCalls });
    if ((counted?.calls ?? 0) > searchPerMinute) return { deferUntil: new Date(minute.getTime() + 60_000) };
  }

  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token.value}`,
      "x-github-api-version": "2022-11-28",
      ...(etag !== undefined && { "if-none-match": etag }),
    },
  });

  const header = (name: string) => Number.parseInt(response.headers.get(name) ?? "", 10) || 0;
  const limited = response.status === 403 || response.status === 429;
  // A refused request's message; the status alone doesn't tell a rate limit from no access.
  const body: unknown = response.ok || response.status === 304 ? null : await response.json().catch(() => null);
  const message = typeof body === "object" && body !== null && "message" in body ? String(body.message) : "";
  // Just past the reset when none remain, or the retry-after time. A secondary rate limit can come
  // with neither, and GitHub asks for a wait of at least a minute then.
  const spent = response.headers.get("x-ratelimit-remaining") === "0";
  const resetAt = spent ? header("x-ratelimit-reset") * 1000 + 1000 : 0;
  const retryAt = header("retry-after") > 0 ? now.getTime() + header("retry-after") * 1000 : 0;
  const named = Math.max(resetAt, retryAt) > now.getTime();
  const secondary = limited && !named && /rate limit/i.test(message) ? now.getTime() + 60_000 : 0;
  const pausedUntil = new Date(Math.max(resetAt, retryAt, secondary));
  if (pausedUntil > now) {
    // Kept per token, so its other Sources wait too. A later answer never shortens the pause.
    await db
      .insert(githubRateLimit)
      .values({ tokenHash, resource, pausedUntil })
      .onConflictDoUpdate({
        target: [githubRateLimit.tokenHash, githubRateLimit.resource],
        set: { pausedUntil: sql`greatest(${githubRateLimit.pausedUntil}, excluded.paused_until)` },
      });
  }

  if (response.ok || response.status === 304) return response;
  if (limited && pausedUntil > now) return { deferUntil: pausedUntil };
  if (response.status === 401) throw new GithubTokenError(token.pasted);
  throw new GithubHttpError(response.status, message);
}
