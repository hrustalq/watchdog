// The smoke run's Telegram Bot API (compose.smoke.yaml). Watchdog calls the fixed host api.telegram.org,
// which the fixtures container answers with TLS and passes on to here, so the real bot loop and senders
// run with no way out. The test talks to it on /fake/: it posts what a person sends the bot, and reads
// the text of every sendMessage the fake received, the bot's replies included.
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { json } from "node:stream/consumers";
import { clearTimeout, setTimeout } from "node:timers";

const updates = [];
const sent = [];
const arrived = new EventEmitter();

/** A long poll, as Telegram does it: it answers once there's an update at or after the offset. */
async function getUpdates({ offset = 0, timeout = 0 }) {
  const waiting = () => updates.filter(({ update_id }) => update_id >= offset);
  if (waiting().length === 0) {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        arrived.off("update", done);
        resolve();
      };
      const timer = setTimeout(done, timeout * 1000);
      arrived.on("update", done);
    });
  }
  return waiting();
}

const methods = {
  getMe: () => ({ username: "watchdog_smoke_bot" }),
  getUpdates,
  sendMessage: ({ text }) => {
    sent.push(text);
    return true;
  },
};

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  // Nothing here takes a query string.
  const pathname = request.url;
  if (request.method === "GET") {
    // The test's read, or else the healthcheck.
    send(response, 200, pathname === "/fake/sent" ? sent : {});
    return;
  }
  const body = await json(request).catch(() => ({}));
  if (pathname === "/fake/updates") {
    const { chat, text } = body;
    updates.push({ update_id: updates.length + 1, message: { chat, text } });
    arrived.emit("update");
    send(response, 200, {});
    return;
  }
  const method = methods[/^\/bot[^/]+\/(\w+)$/.exec(pathname)?.[1]];
  if (method === undefined) {
    send(response, 404, { ok: false, error_code: 404, description: "Not Found" });
    return;
  }
  send(response, 200, { ok: true, result: await method(body) });
}).listen(8080);
