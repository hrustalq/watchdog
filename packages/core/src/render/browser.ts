// What Obscura and the Chromium fallback share: one connection a render, a deadline over all of it,
// and the page's answer checked as a static fetch's would be (docs: Sources and ingestion, "Renderers").
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type BrowserContext, errors, type Page } from "playwright-core";
import { unwatchable } from "../sources/website/page.ts";
import type { Limit } from "./limit.ts";
import type { Renderer } from "./renderer.ts";

/** The most HTML a render may return, the egress guard's cap on a static fetch. */
const maxHtmlBytes = 10 * 1024 * 1024;
/** How long a render waits for a stuck browser to close before it gives up on it. */
const closeWait = 5000;
/** How long a page must stand still before a render without a Region reads it. */
const stillFor = 500;
/** How often the renderer asks the page whether it has stood still. */
const stillPoll = 100;
/**
 * What a waiting render keeps to read the page before its deadline closes the browser: reading it and
 * closing the browser both happen after the wait, and a Region that never matches is read as the page
 * is, so the page's own read names it, at the end of the wait rather than as a timeout.
 */
const readTime = 2000;

/**
 * Installed in a page before its own scripts run, so the render can ask it whether it is done. Obscura
 * reports a request over CDP only once it has answered (checked with playwright-core 1.64.1), so a
 * request in flight is invisible to the renderer there; the page's own `fetch` and `XMLHttpRequest`
 * can see it, and a MutationObserver sees the page being written. The function counts a request in
 * flight as no time at all, and returns otherwise how long ago anything changed.
 */
const pageStillScript = `(() => {
  let inFlight = 0;
  let changedAt = Date.now();
  const note = () => {
    changedAt = Date.now();
  };
  const add = (delta) => {
    inFlight = Math.max(0, inFlight + delta);
    note();
  };
  const fetch = window.fetch;
  if (typeof fetch === "function") {
    window.fetch = function (...args) {
      add(1);
      return fetch.apply(this, args).finally(() => add(-1));
    };
  }
  const XHR = window.XMLHttpRequest;
  if (typeof XHR === "function") {
    const send = XHR.prototype.send;
    XHR.prototype.send = function (...args) {
      add(1);
      this.addEventListener("loadend", () => add(-1), { once: true });
      return send.apply(this, args);
    };
  }
  new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window.watchdogPageStill = () => (inFlight > 0 ? 0 : Date.now() - changedAt);
})();`;

/** The context a page loads in, the URL to open in it, and why the requests it refused were blocked. */
export interface Opened {
  context: BrowserContext;
  url: string;
  blocked: string[];
}

export function createBrowserRenderer<Prepared>({
  name,
  limit,
  connect,
  prepare,
  open,
}: {
  /** As in "Couldn't reach the <name> renderer". */
  name: string;
  /**
   * How many browsers this renderer may hold at once. A render past it waits for one of them, inside
   * its own deadline, and keeps the slot it gets until its browser is closed.
   */
  limit?: Limit;
  connect: (timeout: number) => Promise<Browser>;
  /** Runs before the browser is reached, inside the deadline. What it throws is the render's error. */
  prepare: (url: string, signal: AbortSignal) => Promise<Prepared>;
  /** Opens the context the page loads in. The signal fires when the render stops. */
  open: (browser: Browser, prepared: Prepared, signal: AbortSignal) => Promise<Opened>;
}): Renderer {
  return {
    render: async (url, { timeout, signal, region }) => {
      const started = Date.now();
      /** When the render's deadline ends it, which the wait for the page's readiness also keeps to. */
      const until = started + timeout;
      const deadline = AbortSignal.timeout(timeout);
      const stop = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      const timedOut = () => new Error(`${url} didn't finish rendering within ${String(timeout / 1000)} s`);
      // Why the render stopped, if it was stopped, rather than what the browser said about it.
      const stopped = () => {
        if (deadline.aborted) return timedOut();
        return signal?.aborted === true ? new Error(`Rendering ${url} was stopped`) : undefined;
      };

      let prepared: Prepared;
      try {
        stop.throwIfAborted();
        prepared = await prepare(url, stop);
      } catch (error) {
        throw stopped() ?? error;
      }
      // A render past the limit waits here for a browser of its own. The deadline covers the wait as
      // it covers the rest of the render, so a render that waits too long fails as a timeout.
      let release: (() => void) | undefined;
      try {
        if (limit !== undefined) release = await limit.acquire(stop);
      } catch (error) {
        throw stopped() ?? error;
      }
      try {
        stop.throwIfAborted();
        let browser: Browser;
        try {
          browser = await connect(Math.max(1, timeout - (Date.now() - started)));
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
        // Closing is the only thing that ends a call the browser stopped answering, and a starved
        // browser can ignore the close too. So the answer is raced with the stop itself: whatever the
        // browser does, the render ends at its deadline, as the page's own caller was promised.
        const stopping = new Promise<never>((_, reject) => {
          const fail = () => {
            reject(stopped() ?? new Error(`Rendering ${url} was stopped`));
          };
          if (stop.aborted) fail();
          else stop.addEventListener("abort", fail, { once: true });
        });
        // Rejects only when the work below wins the race, and then nobody is waiting for it.
        void stopping.catch(() => undefined);
        let answer;
        try {
          stop.throwIfAborted();
          answer = await Promise.race([open(browser, prepared, stop).then((opened) => visit(opened, { region, until })), stopping]);
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
        return { html, title, finalUrl, blocked };
      } finally {
        // The browser is closed by now, so its slot is free for the next render.
        release?.();
      }
    },
  };
}

/** Opens the URL, waits for the page to be ready to read, and reads the answer and the page. */
async function visit({ context, url, blocked }: Opened, { region, until }: { region: string | undefined; until: number }) {
  const page = await context.newPage();
  // The page's own scripts are what say it has settled, so the question is installed before they run.
  if (region === undefined) await page.addInitScript({ content: pageStillScript });
  // The render's deadline closes the browser, so the navigation needs no timeout of its own.
  const response = await page.goto(url, { waitUntil: "load", timeout: 0 });
  if (response === null) throw new Error("no answer");
  await ready(page, region, until);
  return {
    status: response.status(),
    statusText: response.statusText(),
    contentType: (await response.headerValue("content-type")) ?? null,
    html: await page.content(),
    title: await page.title(),
    finalUrl: page.url(),
    blocked,
  };
}

/**
 * Waits for the page to be ready to read, inside the render's deadline (docs: Sources and ingestion,
 * "Renderers"). A Region is waited for by its selector, which a page that builds its content after
 * `load` fills last. Without one the page is read once it has stood still for half a second, with
 * nothing in flight: a page that shows a skeleton at `load` and fills it from a fetch would otherwise
 * be read half built, and the next poll would capture the change. A page that never stands still, or
 * a request that never ends, is read when only the time to read it is left, so it doesn't fail a poll
 * that reads it today.
 */
async function ready(page: Page, region: string | undefined, until: number) {
  const stillUntil = until - readTime;
  if (region !== undefined) {
    try {
      await page.waitForSelector(region, { state: "attached", timeout: Math.max(1, stillUntil - Date.now()) });
    } catch (error) {
      // A Region that never matches is read as the page is, so its own read names it as the error.
      if (!(error instanceof errors.TimeoutError)) throw error;
    }
    return;
  }
  while (Date.now() < stillUntil) {
    await sleep(stillPoll, undefined, { ref: false });
    if ((await pageStandingStill(page)) >= stillFor) return;
  }
}

/** How long the page says it has stood still: no request in flight, nothing in it changed. */
async function pageStandingStill(page: Page) {
  const still = await page.evaluate<number | undefined>("window.watchdogPageStill?.()");
  return typeof still === "number" ? still : 0;
}

/** Playwright's message without its call log or the method it names, as in `page.goto: net::ERR_…`. */
function firstLine(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split("\n")[0] ?? "").replace(/^\w+\.\w+: /, "");
}
