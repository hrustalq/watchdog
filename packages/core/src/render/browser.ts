// What Obscura and the Chromium fallback share: one connection a render, a deadline over all of it,
// and the page's answer checked as a static fetch's would be (docs: Sources and ingestion, "Renderers").
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type BrowserContext, errors } from "playwright-core";
import { unwatchable } from "../sources/website/page.ts";
import type { Renderer } from "./renderer.ts";

/** The most HTML a render may return, the egress guard's cap on a static fetch. */
const maxHtmlBytes = 10 * 1024 * 1024;
/** How long a render waits for a stuck browser to close before it gives up on it. */
const closeWait = 5000;

/** The context a page loads in, the URL to open in it, and why the requests it refused were blocked. */
export interface Opened {
  context: BrowserContext;
  url: string;
  blocked: string[];
}

export function createBrowserRenderer({
  name,
  connect,
  open = async (browser, url) => ({ context: await browser.newContext(), url, blocked: [] }),
}: {
  /** As in "Couldn't reach the <name> renderer". */
  name: string;
  connect: (timeout: number) => Promise<Browser>;
  /** Opens the context the page at `url` loads in. The signal fires when the render stops. */
  open?: (browser: Browser, url: string, signal: AbortSignal) => Promise<Opened>;
}): Renderer {
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
        browser = await connect(timeout);
      } catch (error) {
        // Playwright's own connect timeout can fire just before the deadline does.
        if (error instanceof errors.TimeoutError) throw timedOut();
        throw stopped() ?? new Error(`Couldn't reach the ${name} renderer: ${firstLine(error)}`);
      }
      // Closing the browser closes the context and page this render opened, and ends its session.
      // A stop closes it at once, so whatever the page was doing fails.
      let closing: Promise<void> | undefined;
      const close = () => (closing ??= browser.close().catch(() => undefined));
      const onStop = () => void close();
      stop.addEventListener("abort", onStop, { once: true });
      let answer;
      try {
        stop.throwIfAborted();
        answer = await visit(await open(browser, url, stop));
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
      const { html, title, finalUrl, blocked } = answer;
      return { html, title, finalUrl, ...(blocked.length > 0 && { blocked }) };
    },
  };
}

/** Opens the URL and reads the answer and the page once it has loaded. */
async function visit({ context, url, blocked }: Opened) {
  const page = await context.newPage();
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
    blocked: [...blocked],
  };
}

/** Playwright's message without its call log or the method it names, as in `page.goto: net::ERR_…`. */
function firstLine(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n")[0] ?? "").replace(/^\w+\.\w+: /, "");
}
