// The Chromium fallback Renderer: playwright-core connects to Playwright's browser server, one
// connection a render, and every request the page makes is fetched through the egress guard (ADR 0031;
// docs: Sources and ingestion, "The Chromium fallback"). Unlike Obscura, Chromium doesn't block private
// addresses itself.
import { chromium } from "playwright-core";
import { type createEgressFetch, EgressBlockedError } from "../egress/egress.ts";
import { fetchPage } from "../sources/website/page.ts";
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

export function createChromiumRenderer(
  server: { url: string; token: string },
  fetch: ReturnType<typeof createEgressFetch>,
): Renderer {
  const endpoint = `${server.url.replace(/\/+$/, "")}/${server.token}`;
  return createBrowserRenderer({
    name: "Chromium",
    connect: (timeout) => chromium.connect(endpoint, { timeout }),
    open: async (browser, url, signal) => {
      const guarded: typeof fetch = (input, init) => fetch(input, { ...init, signal });
      // Chromium doesn't route the request a fulfilled redirect leads to, so it must never be answered
      // with one. The guard follows the page's redirects here, checking each hop, and the browser opens
      // the URL they end at, answered with what was fetched. Its other requests are fetched with
      // redirects followed too, and answered at the URL they asked for.
      let page: { html: string; finalUrl: string } | undefined = await fetchPage(url, { fetch: guarded });
      const { finalUrl } = page;
      // A service worker's requests skip the route below.
      const context = await browser.newContext({ serviceWorkers: "block" });
      const blocked: string[] = [];
      await context.routeWebSocket(
        () => true,
        (socket) => socket.close(),
      );
      await context.route("**/*", async (route, request) => {
        if (page !== undefined && request.isNavigationRequest() && request.url() === page.finalUrl) {
          const { html } = page;
          page = undefined;
          await route.fulfill({ contentType: "text/html; charset=utf-8", body: html }).catch(() => undefined);
          return;
        }
        try {
          const headers = Object.entries(await request.allHeaders()).filter(
            ([header]) => !header.startsWith(":") && !connectionHeaders.has(header),
          );
          const response = await guarded(request.url(), {
            method: request.method(),
            headers,
            body: request.postDataBuffer(),
          });
          const body = Buffer.from(await response.arrayBuffer());
          const kept = [...response.headers].filter(([header]) => !bodyHeaders.has(header));
          await route.fulfill({ status: response.status, headers: Object.fromEntries(kept), body });
        } catch (error) {
          if (error instanceof EgressBlockedError) blocked.push(error.message);
          // The page may already be closed.
          await route.abort(error instanceof EgressBlockedError ? "blockedbyclient" : "failed").catch(() => undefined);
        }
      });
      return { context, url: finalUrl, blocked };
    },
  });
}
