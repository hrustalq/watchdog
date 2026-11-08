// The URL in a Digest mail's List-Unsubscribe header (docs: Actions and delivery, "Digests"). A mail
// client's one-click unsubscribe POSTs to it with no session (RFC 8058). A GET changes nothing and
// shows a button, because mail gateways fetch every link on delivery. A route handler, not a page,
// because the POST comes from a mail client, not from a form Next rendered.
import type { NextRequest } from "next/server";
import { server } from "@/lib/server";
import { unsubscribe, type UnsubscribeResult } from "@/lib/unsubscribe";

// The app's own colours and type, inline, because this page loads no stylesheet.
const style = `
:root { color-scheme: light dark; --bg: oklch(1 0 0); --fg: oklch(0.1448 0 0); --muted: oklch(0.4495 0 0);
  --primary: oklch(0.205 0 0); --on-primary: oklch(0.9851 0 0); }
@media (prefers-color-scheme: dark) { :root { --bg: oklch(0.173 0 0); --fg: oklch(0.9851 0 0);
  --muted: oklch(0.7187 0 0); --primary: oklch(0.9219 0 0); --on-primary: oklch(0.173 0 0); } }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 4rem 1rem; box-sizing: border-box;
  background: var(--bg); color: var(--fg); font: 0.875rem/1.5 ui-sans-serif, system-ui, sans-serif; }
main { width: 100%; max-width: 24rem; display: flex; flex-direction: column; gap: 1.5rem; }
h1 { margin: 0; font-size: 1.5rem; font-weight: 650; line-height: 1.2; }
p { margin: 0.25rem 0 0; color: var(--muted); }
button { font: inherit; font-weight: 500; height: 2.25rem; padding: 0 1rem; border: 0; border-radius: 0.5rem;
  background: var(--primary); color: var(--on-primary); cursor: pointer; }
button:focus-visible { outline: 3px solid color-mix(in oklch, var(--fg) 30%, transparent); outline-offset: 2px; }
`;

/** Only fixed text goes in, so nothing in a request can write markup. */
function page(status: number, title: string, text: string, form = "") {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${title} · Watchdog</title><style>${style}</style></head>
<body><main><div><h1>${title}</h1><p>${text}</p></div>${form}</main></body></html>`;
  return new Response(html, {
    status,
    // The URL holds the token, which no other site should get in a Referer.
    headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer", "cache-control": "no-store" },
  });
}

const invalid = () => page(400, "This unsubscribe link isn't valid", "Check that the whole link from the mail was opened.");

const outcomes: Record<Exclude<UnsubscribeResult, "invalid">, [string, string]> = {
  removed: ["Unsubscribed", "This address won't get this Digest any more."],
  disabled: [
    "Unsubscribed",
    "This was the Digest's only address, so the Digest is turned off. Its owner can turn it on again on the Rules screen.",
  ],
  already: ["Already unsubscribed", "This address doesn't get this Digest."],
};

export function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token") ?? "";
  // The signature is checked here only to say early that the link is broken. The POST checks it again.
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return invalid();
  // With no action, the form posts back to this URL, token and all.
  return page(
    200,
    "Unsubscribe from this Digest?",
    "This address will stop getting this Digest. Nothing changes until you press the button.",
    `<form method="post"><button type="submit">Unsubscribe</button></form>`,
  );
}

export async function POST(request: NextRequest) {
  const { db, authSecret } = server();
  const result = await unsubscribe(db, request.nextUrl.searchParams.get("token") ?? "", authSecret);
  if (result === "invalid") return invalid();
  const [title, text] = outcomes[result];
  return page(200, title, text);
}
