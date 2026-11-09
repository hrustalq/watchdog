// The Chromium fallback Renderer: playwright-core connects to Playwright's browser server through its
// token gate, one connection a render, and every request the page makes is fetched through the egress
// guard (ADR 0031; docs: Sources and ingestion, "The Chromium fallback"). Unlike Obscura, Chromium
// doesn't block private addresses itself.
import { chromium } from "playwright-core";
import type { Headers } from "undici";
import { type createEgressFetch, EgressBlockedError } from "../egress/egress.ts";
import { unwatchable } from "../sources/website/page.ts";
import { createBrowserRenderer } from "./browser.ts";
import type { Renderer } from "./renderer.ts";

/** Request headers that describe the browser's own connection, which the guard's fetch makes anew. */
const connectionHeaders = new Set([
  "accept-encoding",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
/** Response headers that no longer hold once the guard's fetch has decoded the body. */
const bodyHeaders = new Set(["connection", "content-encoding", "content-length", "transfer-encoding"]);

/** An answer as Chromium is given it, every Set-Cookie kept (Playwright splits them at newlines). */
async function fulfilment(response: { status: number; headers: Headers; arrayBuffer: () => Promise<ArrayBuffer> }) {
  const headers: Record<string, string> = {};
  for (const [header, value] of response.headers) {
    if (!bodyHeaders.has(header) && header !== "set-cookie") headers[header] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies.join("\n");
  return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) };
}

export function createChromiumRenderer(
  server: { url: string; token: string },
  fetch: ReturnType<typeof createEgressFetch>,
): Renderer {
  const headers = { authorization: `Bearer ${server.token}` };
  return createBrowserRenderer({
    name: "Chromium",
    connect: (timeout) => chromium.connect(server.url, { headers, timeout }),
    // Chromium doesn't route the request a fulfilled redirect leads to, so it must never be answered
    // with one. The guard follows the page's redirects before the browser is reached, checking each
    // hop, and the page is checked as a static fetch is. The browser then opens the URL they ended at.
    prepare: async (url, signal) => {
      const response = await fetch(url, { headers: { accept: "text/html, application/xhtml+xml;q=0.9" }, signal });
      const { status, statusText } = response;
      const problem = unwatchable(url, { status, statusText, contentType: response.headers.get("content-type") });
      if (problem !== undefined) {
        await response.body?.cancel();
        throw new Error(problem);
      }
      return { url: response.url || url, answer: await fulfilment(response) };
    },
    open: async (browser, page, signal) => {
      const guarded: typeof fetch = (input, init) => fetch(input, { ...init, signal });
      // A request's URL never carries the fragment.
      const pageUrl = new URL(page.url);
      pageUrl.hash = "";
      let waiting: typeof page.answer | undefined = page.answer;
      // A service worker's requests skip the route below.
      const context = await browser.newContext({ serviceWorkers: "block" });
      const blocked: string[] = [];
      await context.routeWebSocket(
        () => true,
        (socket) => socket.close(),
      );
      await context.route("**/*", async (route, request) => {
        try {
          if (waiting !== undefined && request.isNavigationRequest() && request.url() === pageUrl.href) {
            const answer = waiting;
            waiting = undefined;
            await route.fulfill(answer);
            return;
          }
          const requestHeaders = Object.entries(await request.allHeaders()).filter(
            ([header]) => !header.startsWith(":") && !connectionHeaders.has(header),
          );
          // Redirects are followed here too, and the answer is given at the URL the page asked for.
          const response = await guarded(request.url(), {
            method: request.method(),
            headers: requestHeaders,
            body: request.postDataBuffer(),
          });
          await route.fulfill(await fulfilment(response));
        } catch (error) {
          if (error instanceof EgressBlockedError) blocked.push(error.message);
          // The page may already be closed.
          await route.abort(error instanceof EgressBlockedError ? "blockedbyclient" : "failed").catch(() => undefined);
        }
      });
      return { context, url: page.url, blocked };
    },
  });
}
