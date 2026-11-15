import { deflateRawSync, inflateRawSync } from "node:zlib";
import { cookies } from "next/headers";
import { server } from "./server.ts";

/**
 * What a refused form held, for the page its action redirects to. It goes in a cookie, never the URL
 * (#134): a link can't set a cookie, so a URL alone never fills a form, and the values stay out of
 * access logs and browser history. Each screen scopes the cookie to its own path, and it lasts long
 * enough for the redirect and a reload. It isn't cleared after a save: only a page whose URL says
 * a form was refused reads it.
 */
export type SentBack = Record<string, string>;

const name = "sent-back";
const maxAgeSeconds = 5 * 60;
// A browser keeps about 4 KB for a cookie with its name and attributes, and drops a larger one.
const maxValueLength = 3800;
// Far more than any form holds, so a forged cookie can't make the page inflate megabytes.
const maxJsonBytes = 64 * 1024;

/**
 * Undefined when the values are too long to keep. Deflated, because YAML compresses about threefold
 * and a rule draft is the longest value, then base64url, which needs no escaping in a cookie.
 */
export function encodeSentBack(values: SentBack): string | undefined {
  const value = deflateRawSync(JSON.stringify(values)).toString("base64url");
  return value.length > maxValueLength ? undefined : value;
}

/** Undefined for no cookie, or one that isn't ours. An empty value inflates to bad JSON, which throws. */
export function decodeSentBack(value = ""): SentBack | undefined {
  try {
    const json = inflateRawSync(Buffer.from(value, "base64url"), { maxOutputLength: maxJsonBytes });
    const parsed: unknown = JSON.parse(json.toString());
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const entries = Object.entries(parsed);
    return entries.every(([, field]) => typeof field === "string") ? Object.fromEntries(entries) : undefined;
  } catch {
    return undefined;
  }
}

async function setSentBack(path: string, value: string, maxAge: number) {
  (await cookies()).set(name, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: server().baseURL.startsWith("https:"),
    path,
    maxAge,
  });
}

/**
 * Keeps the values for the page at `path`, and says whether it could. Values too long to keep clear
 * the old ones instead, and the action says so in the page's URL.
 */
export async function keepSentBack(path: string, values: SentBack) {
  const value = encodeSentBack(values);
  await setSentBack(path, value ?? "", value === undefined ? 0 : maxAgeSeconds);
  return value !== undefined;
}

/** The values kept for this page, if any. Only a page whose URL says a form was refused reads them. */
export async function readSentBack(): Promise<SentBack | undefined> {
  return decodeSentBack((await cookies()).get(name)?.value);
}
