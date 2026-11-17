// The Telegram Source link's code, kept in a cookie so a reload can show it again without replacing
// it. It lives here rather than in the "use server" actions file so it is not itself a Server Action.
import { linkCodeMinutes } from "@watchdog/core";
import { cookies } from "next/headers";
import { server } from "./server.ts";
import { sourceLinkCookie, sourceLinkCookieValue } from "./sources.ts";

/** Keeps the code for the page to show, however often it's reloaded. See sourceLinkInCookie. */
export async function keepSourceLink(sourceId: string, code: string) {
  (await cookies()).set(sourceLinkCookie, sourceLinkCookieValue(sourceId, code), {
    httpOnly: true,
    sameSite: "lax",
    secure: server().baseURL.startsWith("https:"),
    // Covers /sources and the guided setup under /sources/new, so both can show the code.
    path: "/sources",
    maxAge: linkCodeMinutes * 60,
  });
}
