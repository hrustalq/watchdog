// The Obscura Renderer: playwright-core drives Obscura over CDP, one connection a render (ADR 0010;
// docs: Sources and ingestion, "Obscura"). Obscura blocks private addresses itself, so its requests
// don't go through the egress guard.
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, chromium, errors } from "playwright-core";
import { unwatchable } from "../sources/website/page.ts";
import type { Renderer } from "./renderer.ts";

/** The most HTML a render may return, the egress guard's cap on a static fetch. */
const maxHtmlBytes = 10 * 1024 * 1024;
/** How long a render waits for a stuck browser to close before it gives up on it. */
const closeWait = 5000;

export function createObscuraRenderer(obscura: { cdpUrl: string; cdpToken: string | undefined }): Renderer {
  const headers = obscura.cdpToken === undefined ? {} : { authorization: `Bearer ${obscura.cdpToken}` };
  return {
    render: async (url, { timeout, signal }) => {
      const deadline = AbortSignal.timeout(timeout);
      const stop = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      const timedOut = () => new Error(`${url} didn't finish rendering within ${String(timeout / 1000)} s`);
      // Why the render stopped, if it was stopped, rather than what the browser said about it.
      const stopped = () => {
        if (deadline.aborted) return timedOut();
        return signal?.aborted === true ? new Error(`Rendering ${url} was stopped`) : undefined;
      };

      let browser: Browser;
      try {
        browser = await chromium.connectOverCDP(obscura.cdpUrl, { headers, timeout });
      } catch (error) {
        // Playwright's own connect timeout can fire just before the deadline does.
        if (error instanceof errors.TimeoutError) throw timedOut();
        throw stopped() ?? new Error(`Couldn't reach the Obscura renderer: ${firstLine(error)}`);
      }
      // Closing the browser closes the context and page this render opened, and ends its CDP session.
      // A stop closes it at once, so whatever the page was doing fails.
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= browser.close().catch(() => undefined));
      const onStop = () => void close();
      stop.addEventListener("abort", onStop, { once: true });
      let answer;
      try {
        stop.throwIfAborted();
        answer = await visit(browser, url);
      } catch (error) {
        throw stopped() ?? new Error(`${url} couldn't be rendered: ${firstLine(error)}`);
      } finally {
        stop.removeEventListener("abort", onStop);
        // A stuck browser may never answer the close, and the deadline still holds.
        await Promise.race([close(), sleep(closeWait, undefined, { ref: false })]);
      }
      const problem = unwatchable(url, answer);
      if (problem !== undefined) throw new Error(problem);
      if (Buffer.byteLength(answer.html) > maxHtmlBytes) throw new Error(`${url} rendered more than 10 MB of HTML`);
      return { html: answer.html, title: answer.title, finalUrl: answer.finalUrl };
    },
  };
}

/** Opens the URL in a new context and reads the answer and the page once it has loaded. */
async function visit(browser: Browser, url: string) {
  const page = await (await browser.newContext()).newPage();
  // The render's deadline closes the browser, so the navigation needs no timeout of its own.
  const response = await page.goto(url, { waitUntil: "load", timeout: 0 });
  if (response === null) throw new Error("no answer");
  return {
    status: response.status(),
    statusText: response.statusText(),
    contentType: (await response.headerValue("content-type")) ?? null,
    html: await page.content(),
    title: await page.title(),
    finalUrl: page.url(),
  };
}

/** Playwright's message without its call log or the method it names, as in `page.goto: net::ERR_…`. */
function firstLine(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n")[0] ?? "").replace(/^\w+\.\w+: /, "");
}
