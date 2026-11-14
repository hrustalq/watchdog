// The Chromium fallback's front door (ADR 0031). Playwright's browser server has no authentication: it
// tells anyone who asks `GET /json` the path it serves at. So it listens on loopback only, and this gate
// lets through just the WebSocket upgrades that carry `Authorization: Bearer <CHROMIUM_TOKEN>`, as
// Obscura checks its token. Every other request gets 401.
//
// The gate starts each browser itself instead of leaving it to `run-server`, because the launch options
// are the gate's to choose: Playwright launches Chromium without its sandbox unless `chromiumSandbox` is
// true, and `run-server` drops that option from anything a client sends unless it runs with `--unsafe`,
// which would let a client pass launch arguments or an executable path. One browser server a connection,
// as `run-server` gave each connection before.
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import { chromium } from "playwright-core";

const token = process.env.CHROMIUM_TOKEN ?? "";
if (token.length < 32) {
  console.error("Set CHROMIUM_TOKEN to at least 32 characters");
  process.exit(1);
}
const expected = Buffer.from(`Bearer ${token}`);
const allowed = (header = "") => {
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

// The sandbox creates the namespaces that confine a page, so it needs the unprivileged user namespaces
// Docker's default seccomp profile refuses; compose.yaml grants them through this service's profile.
const startBrowser = () =>
  chromium.launchServer({ chromiumSandbox: true, host: "127.0.0.1", port: 0, wsPath: "/" });

const refuse = "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const unavailable = "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const gate = createServer((_request, response) => {
  // A request the gate doesn't proxy has no reason to hold its connection open.
  response.writeHead(401, { connection: "close" }).end();
});
gate.on("upgrade", async (request, socket, head) => {
  socket.on("error", () => socket.destroy());
  if (!allowed(request.headers.authorization)) {
    socket.end(refuse);
    return;
  }
  let server;
  try {
    server = await startBrowser();
  } catch (error) {
    console.error("Couldn't start a browser:", error);
    socket.end(unavailable);
    return;
  }
  const endpoint = new URL(server.wsEndpoint());
  const upstream = connect({ port: Number(endpoint.port), host: endpoint.hostname }, () => {
    // The browser server answers only at /, and only to a loopback Host, which guards it against DNS
    // rebinding. The token goes no further than the gate.
    const search = new URL(request.url ?? "/", "http://gate").search;
    let lines = `${request.method} /${search} HTTP/1.1\r\nHost: ${endpoint.host}\r\n`;
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      if (!["authorization", "host"].includes(request.rawHeaders[i].toLowerCase())) {
        lines += `${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}\r\n`;
      }
    }
    upstream.write(`${lines}\r\n`);
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  // One connection, one browser: closing either end closes the browser with it.
  let closed = false;
  const done = () => {
    if (closed) return;
    closed = true;
    upstream.destroy();
    void server.kill().catch(() => undefined);
  };
  socket.on("close", done);
  upstream.on("close", done);
});
gate.listen(3000, "0.0.0.0", () => console.log("Chromium gate listening on port 3000"));
