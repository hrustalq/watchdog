// A Renderer turns a URL into the page's HTML after its scripts have run. Obscura and the Chromium
// fallback sit behind it (docs: Sources and ingestion, "Renderers").

/** The longest a whole render may take, from connecting to reading the page. */
export const renderTimeout = 30_000;

export interface Rendered {
  html: string;
  title: string;
  /** The URL the page ended on, after any redirects. */
  finalUrl: string;
}

export interface Renderer {
  /** Throws why the page couldn't be rendered. The browser's page and context are closed either way. */
  render: (url: string, options: { timeout: number; signal?: AbortSignal }) => Promise<Rendered>;
}
