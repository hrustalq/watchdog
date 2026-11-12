// The smoke run's website (compose.smoke.yaml): one small site whose pages it watches for changes.
// Each page is served in two versions, and a POST to /flip makes every page serve its second version
// from then on, so the next poll of a website Source finds a change.
//
// On every page the status line is written by a script. A Static read strips the script, so it sees
// only the page's heading and the line above the script's, while a Renderer (Obscura or Chromium) runs
// the script and sees the text it wrote. That difference is what shows a render really rendered.
import { createServer } from "node:http";

/** The pages the test adds, each one website Source's URL. Their titles carry "platform" so they can't
 * be taken for the "Acme status" feed the M3 test's Source is named after. */
const pages = new Map([
  ["status", "Acme platform status"],
  ["uptime", "Acme platform uptime"],
  ["changelog", "Acme platform changelog"],
]);

/** The line the script writes. Only a Renderer's read of the page holds it. */
const versions = ["All systems operational", "Partial outage in eu-west"];

let flipped = false;

function page(title) {
  const line = versions[flipped ? 1 : 0];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <p>${line}</p>
    <p id="rendered"></p>
    <script>
      document.getElementById("rendered").textContent = ${JSON.stringify(`Rendered text: ${line}`)};
    </script>
  </body>
</html>
`;
}

function send(response, status, contentType, body) {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

createServer((request, response) => {
  // Nothing here takes a query string, so the path is the URL without one.
  const pathname = (request.url ?? "/").split("?")[0];
  const name = /^\/page\/([\w-]+)$/.exec(pathname)?.[1];
  const title = name === undefined ? undefined : pages.get(name);
  if (request.method === "GET" && title !== undefined) {
    send(response, 200, "text/html; charset=utf-8", page(title));
    return;
  }
  // What the test reads to know the flip went through, and the healthcheck's answer.
  if (request.method === "GET" && (pathname === "/" || pathname === "/state")) {
    send(response, 200, "application/json; charset=utf-8", JSON.stringify({ flipped }));
    return;
  }
  if (request.method === "GET" && pathname === "/robots.txt") {
    // A website Source on self-hosted still reads robots.txt, and this one allows everything.
    send(response, 200, "text/plain; charset=utf-8", "User-agent: *\nAllow: /\n");
    return;
  }
  if (request.method === "POST" && pathname === "/flip") {
    request.resume();
    request.on("end", () => {
      flipped = true;
      send(response, 200, "application/json; charset=utf-8", JSON.stringify({ flipped }));
    });
    return;
  }
  send(response, 404, "text/plain; charset=utf-8", "Not found\n");
}).listen(8080);
