// The Chromium fallback's front door (ADR 0031). Playwright's browser server has no authentication: it
// tells anyone who asks `GET /json` the path it serves at. So it listens on loopback only, and this gate
// lets through just the WebSocket upgrades that carry `Authorization: Bearer <CHROMIUM_TOKEN>`, as Obscura
// checks its token. Every other request gets 401.
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";

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

// Not in unsafe mode, so a client can't pass launch arguments or an executable path. The server starts
// a new browser for each connection, and Playwright starts it without Chromium's sandbox, so what holds
// a page in is the internal network. If the server exits, so does the gate, and Compose restarts it.
const browserServer = spawn(
  process.execPath,
  ["node_modules/playwright-core/cli.js", "run-server", "--host", "127.0.0.1", "--port", "3001"],
  { stdio: "inherit" },
);
browserServer.on("exit", (code) => process.exit(code ?? 1));

const refuse = "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const gate = createServer((_request, response) => {
  response.writeHead(401).end();
});
gate.on("upgrade", (request, socket, head) => {
  socket.on("error", () => socket.destroy());
  if (!allowed(request.headers.authorization)) {
    socket.end(refuse);
    return;
  }
  const upstream = connect(3001, "127.0.0.1", () => {
    // The browser server answers only at /, and only to a loopback Host, which guards it against DNS
    // rebinding. The token goes no further than the gate.
    const search = new URL(request.url ?? "/", "http://gate").search;
    let lines = `${request.method} /${search} HTTP/1.1\r\nHost: 127.0.0.1:3001\r\n`;
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
  socket.on("close", () => upstream.destroy());
});
gate.listen(3000, "0.0.0.0", () => console.log("Chromium gate listening on port 3000"));
