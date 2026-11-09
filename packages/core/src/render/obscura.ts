// The Obscura Renderer: playwright-core drives Obscura over CDP, one connection a render (ADR 0010;
// docs: Sources and ingestion, "Obscura"). Obscura blocks private addresses itself, so its requests
// don't go through the egress guard.
import { chromium } from "playwright-core";
import { createBrowserRenderer } from "./browser.ts";
import type { Renderer } from "./renderer.ts";

export function createObscuraRenderer(obscura: { cdpUrl: string; cdpToken: string | undefined }): Renderer {
  const headers = obscura.cdpToken === undefined ? {} : { authorization: `Bearer ${obscura.cdpToken}` };
  return createBrowserRenderer({
    name: "Obscura",
    connect: (timeout) => chromium.connectOverCDP(obscura.cdpUrl, { headers, timeout }),
    prepare: (url) => Promise.resolve(url),
    open: async (browser, url) => ({ context: await browser.newContext(), url, blocked: [] }),
  });
}
