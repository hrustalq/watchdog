import { cookies } from "next/headers";
import { server } from "./server.ts";

/**
 * What a refused form held, for the page its action redirects to. It goes in a cookie, never the URL
 * (#134): a link can't set a cookie, so a URL alone never fills a form, and the values stay out of
 * access logs and browser history. Each screen scopes the cookie to its own path, and it lasts long
 * enough for the redirect and a reload. A page can't delete a cookie, so the next save clears it.
 */
export type SentBack = Record<string, string>;

const name = "sent-back";
const maxAgeSeconds = 5 * 60;
// A browser keeps about 4 KB for a cookie with its name and attributes, and drops a larger one.
const maxValueLength = 3800;

/** Undefined when the values are too long to keep. Base64url needs no escaping in a cookie. */
export function encodeSentBack(values: SentBack): string | undefined {
  const value = Buffer.from(JSON.stringify(values)).toString("base64url");
  return value.length > maxValueLength ? undefined : value;
}

export function decodeSentBack(value: string | undefined): SentBack | undefined {
  if (value === undefined || value === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
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
 * Keeps the values for the page at `path`. Values too long to keep clear the old ones instead, so a
 * page that finds none after a refusal says what was entered can't come back.
 */
export async function keepSentBack(path: string, values: SentBack) {
  const value = encodeSentBack(values);
  await setSentBack(path, value ?? "", value === undefined ? 0 : maxAgeSeconds);
}

export async function clearSentBack(path: string) {
  await setSentBack(path, "", 0);
}

/** The values kept for this page, if any. Only a page whose URL says a form was refused reads them. */
export async function readSentBack(): Promise<SentBack | undefined> {
  return decodeSentBack((await cookies()).get(name)?.value);
}
