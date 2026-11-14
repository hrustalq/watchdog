// A Renderer turns a URL into the page's HTML after its scripts have run. Obscura and the Chromium
// fallback sit behind it (docs: Sources and ingestion, "Renderers").

/** The longest a whole render may take, from connecting to reading the page. */
export const renderTimeout = 30_000;

export interface Rendered {
  html: string;
  title: string;
  /** The URL the page ended on, after any redirects. */
  finalUrl: string;
  /** Why the egress guard refused requests the page made, which the render went on without. */
  blocked?: string[];
}

export interface RenderOptions {
  /** The longest the whole render may take, from connecting to reading the page. */
  timeout: number;
  /** Ends the render early, as a poll stopped because its worker is stopping does. */
  signal?: AbortSignal;
  /**
   * The Source's Region, as a CSS selector: the page is read once it matches. Without one the render
   * waits for the page to stand still after `load`, so a page its scripts build is read once, not
   * half built.
   */
  region?: string;
}

export interface Renderer {
  /** Throws why the page couldn't be rendered. The browser's page and context are closed either way. */
  render: (url: string, options: RenderOptions) => Promise<Rendered>;
}
