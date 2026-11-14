import { createServer, type IncomingMessage } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { GenericContainer, type StartedTestContainer, TestContainers, Wait } from "testcontainers";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { createEgressFetch } from "../egress/egress.ts";
import { createChromiumRenderer, maxChromiumBrowsers } from "./chromium.ts";
import { renderTimeout } from "./renderer.ts";

// The Chromium fallback as compose.yaml builds it, rendering pages from a server in this process
// (docs: Testing and CI, "no live HTTP"). The container can reach that server at
// host.testcontainers.internal, so a request that skipped the egress guard would arrive there.
const token = "a-test-token-of-at-least-thirty-two-characters";
/** The private address host.testcontainers.internal resolves to, as the guard sees it. */
const gatewayAddress = "172.17.0.1";
const blocked = (host: string, address = host) =>
  `Watchdog doesn't fetch ${host}: it resolves to the blocked address ${address}`;

/** Starts the server on a free port and returns the port. */
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The server has no port");
  return address.port;
}

describe("the Chromium Renderer", () => {
  let chromium: StartedTestContainer;
  /** The page's public origin, which the guard lets through on this self-hosted install. */
  let site: string;
  /** The same server at a private address the container can reach. */
  let hidden: string;
  const asked: string[] = [];
  const upgrades: string[] = [];
  /** Answers to /hold.js the test withholds, so a render keeps its browser until the test lets go. */
  const held: (() => void)[] = [];
  let released = false;
  const releaseHold = () => {
    released = true;
    for (const answer of held.splice(0)) answer();
  };
  /** Waits for what a test reads next, so the test reads the moment it names rather than a guess. */
  const waitFor = async (holds: () => boolean | Promise<boolean>, what: string) => {
    const deadline = Date.now() + 20_000;
    while (!(await holds())) {
      if (Date.now() > deadline) throw new Error(`Waited 20 s for ${what}`);
      await sleep(100);
    }
  };
  /**
   * How many browser processes the service is running, read from its own process table. A page's
   * helper processes carry `--type=`, and the zombie a closed browser leaves behind carries no
   * command line at all, so each match is one browser.
   */
  const browserProcesses = async () => {
    const { output } = await chromium.exec([
      "node",
      "-e",
      `const { readdirSync, readFileSync } = require("node:fs");
let browsers = 0;
for (const entry of readdirSync("/proc")) {
  if (!/^[0-9]+$/.test(entry) || entry === String(process.pid)) continue;
  let args;
  try {
    args = readFileSync("/proc/" + entry + "/cmdline").toString();
  } catch {
    continue;
  }
  if (!args.includes("chrome-headless-shell") || args.includes("--type=")) continue;
  browsers += 1;
}
process.stdout.write(String(browsers));`,
    ]);
    return Number(output);
  };
  /**
   * How many sessions the service is serving, read from its own socket table: one accepted connection
   * on the browser server's port (3001, `0BB9` in hex) per render that holds a browser. This is what
   * the limit bounds, and unlike a process it ends before the browser is gone: Playwright kills a
   * closed browser asynchronously, so its process can outlive the render's slot for a moment.
   */
  const sessionsServed = async () => {
    const { output } = await chromium.exec([
      "node",
      "-e",
      `const { readFileSync } = require("node:fs");
let sessions = 0;
for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const line of text.split("\\n").slice(1)) {
    const fields = line.trim().split(/\\s+/);
    if (fields.length < 4) continue;
    if (fields[1].split(":")[1] === "0BB9" && fields[3] === "01") sessions += 1;
  }
}
process.stdout.write(String(sessions));`,
    ]);
    return Number(output);
  };
  let renderer: ReturnType<typeof createChromiumRenderer>;
  let fetch: ReturnType<typeof createEgressFetch>;

  beforeAll(async () => {
    const server = createServer((request: IncomingMessage, response) => {
      const path = request.url ?? "";
      asked.push(path);
      const html = (body: string) => response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
      if (path === "/status") {
        return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme status</title>
<script src="${hidden}/secret.js"></script>
<script src="http://127.0.0.1:1/loopback.js"></script>
<script src="http://169.254.169.254/latest/meta-data/"></script>
<script>new WebSocket("${hidden.replace("http:", "ws:")}/socket");</script>
<script src="/app.js"></script></head>
<body><main id="status">Loading…</main></body></html>`);
      }
      if (path === "/app.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        return response.end(`addEventListener("DOMContentLoaded", () => {
  document.getElementById("status").textContent = "All systems operational";
});`);
      }
      if (path === "/old") return response.writeHead(302, { location: "/status" }).end();
      if (path === "/to-hidden") return response.writeHead(302, { location: `${hidden}/status` }).end();
      if (path === "/slow") {
        return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Slow page</title>
<script src="/hold.js"></script></head><body><main>Slow page</main></body></html>`);
      }
      if (path === "/hold.js") {
        response.writeHead(200, { "content-type": "text/javascript" });
        const answer = () => response.end(`document.body.dataset.held = "done";`);
        // Held open, the page's load event never fires, so the render keeps its browser.
        if (released) answer();
        else held.push(answer);
        return;
      }
      return response.writeHead(404).end("Not found");
    });
    server.on("upgrade", (request: IncomingMessage, socket) => {
      upgrades.push(request.url ?? "");
      socket.destroy();
    });
    const port = await listen(server);
    await TestContainers.exposeHostPorts(port);
    site = `http://acme.test:${String(port)}`;
    hidden = `http://host.testcontainers.internal:${String(port)}`;

    const image = await GenericContainer.fromDockerfile(new URL("../../../../docker/chromium", import.meta.url).pathname).build();
    chromium = await image.withEnvironment({ CHROMIUM_TOKEN: token }).withExposedPorts(3000)
      .withSharedMemorySize(1024 ** 3)
      // The gate listens first; the browser server behind it is ready once it says so.
      .withWaitStrategy(Wait.forLogMessage("Listening on ws://127.0.0.1:3001"))
      .start();

    const config = loadConfig(
      {
        DATABASE_URL: "postgres://unused:unused@localhost:5432/unused",
        BETTER_AUTH_SECRET: "a".repeat(32),
        BETTER_AUTH_URL: "http://localhost:3000",
        WATCHDOG_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        EGRESS_ALLOWLIST: "acme.test",
      },
      () => undefined,
    );
    // No real DNS: the page's host is this machine, allowlisted, and the container's host is private.
    const addresses: Record<string, string> = { "acme.test": "127.0.0.1", "host.testcontainers.internal": gatewayAddress };
    const lookup = (host: string) => {
      const address = addresses[host];
      return Promise.resolve(address === undefined ? [] : [{ address, family: 4 }]);
    };
    const url = `ws://${chromium.getHost()}:${String(chromium.getMappedPort(3000))}`;
    // The guard stops a request after 30 s, which would cut short a page the tests below hold open
    // for longer; the render's own deadline is what bounds a request in production.
    fetch = createEgressFetch(config, { lookup, timeoutMs: 120_000 });
    renderer = createChromiumRenderer({ url, token }, fetch);
    return async () => {
      server.closeAllConnections();
      server.close();
      await chromium.stop();
    };
  }, 600_000);

  it("renders a scripted page through the guard, and blocked requests never reach their address", async () => {
    asked.length = 0;
    const rendered = await renderer.render(`${site}/status`, { timeout: 20_000 });

    expect(rendered.title).toBe("Acme status");
    expect(rendered.html).toContain("All systems operational");
    expect(rendered.finalUrl).toBe(`${site}/status`);
    expect(rendered.blocked).toEqual(
      expect.arrayContaining([
        blocked("host.testcontainers.internal", gatewayAddress),
        blocked("127.0.0.1"),
        blocked("169.254.169.254"),
      ]),
    );
    // Only the guard's own fetches of the public page arrived; the WebSocket was closed in the browser.
    expect(asked).toEqual(["/status", "/app.js"]);
    expect(upgrades).toEqual([]);
  });

  it("follows a redirect in the guard, checking each hop, and fails a page whose redirect leads somewhere blocked", async () => {
    asked.length = 0;
    expect((await renderer.render(`${site}/old`, { timeout: 20_000 })).finalUrl).toBe(`${site}/status`);
    // The browser never sees the redirect: the guard follows it, and the page opens where it ended.
    expect(asked).toEqual(["/old", "/status", "/app.js"]);

    // A fragment never reaches the server, so the page is still answered with what was fetched.
    asked.length = 0;
    expect((await renderer.render(`${site}/status#plans`, { timeout: 20_000 })).html).toContain("All systems operational");
    expect(asked).toEqual(["/status", "/app.js"]);

    asked.length = 0;
    // The same error a static fetch of the page gives.
    await expect(renderer.render(`${site}/to-hidden`, { timeout: 20_000 })).rejects.toThrow(
      blocked("host.testcontainers.internal", gatewayAddress),
    );
    expect(asked).toEqual(["/to-hidden"]);
  });

  it("checks the page as a static fetch does, before reaching the browser", async () => {
    await expect(renderer.render(`${site}/missing`, { timeout: 20_000 })).rejects.toThrow(
      new Error(`${site}/missing answered 404 Not Found`),
    );
  });

  it("refuses a connection without the token, and tells nobody the browser server's address", async () => {
    const http = `http://${chromium.getHost()}:${String(chromium.getMappedPort(3000))}`;
    const wrongToken = "not-the-token-but-long-enough-to-look-like-one";
    const wrong = createChromiumRenderer({ url: http.replace("http:", "ws:"), token: wrongToken }, fetch);
    const refused = wrong.render(`${site}/status`, { timeout: 10_000 });
    await expect(refused).rejects.toThrow(/^Couldn't reach the Chromium renderer: .*401/);
    await expect(refused).rejects.not.toThrow(wrongToken);
    // Playwright's server would answer /json with the path it serves at.
    for (const path of ["/json", "/", `/${token}`]) {
      const response = await globalThis.fetch(`${http}${path}`);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
    }
  });

  it(
    `runs no more than ${String(maxChromiumBrowsers)} browsers for ${String(maxChromiumBrowsers + 2)} renders at once, and finishes them all`,
    async () => {
      released = false;
      // Every render holds its browser until /hold.js answers, so watching the service while the
      // renders run reads sessions that are live, not ones that are about to be.
      const observed: number[] = [];
      const sampling = { done: false };
      const sampler = (async () => {
        while (!sampling.done) {
          observed.push(await sessionsServed());
          await sleep(100);
        }
      })();
      try {
        const renders = Array.from({ length: maxChromiumBrowsers + 2 }, () =>
          renderer.render(`${site}/slow`, { timeout: 25_000 }),
        );
        // The limit is full once every slot's page is waiting on its script. Nothing closes in this
        // window, so the browsers behind the sessions are countable too.
        await waitFor(() => held.length === maxChromiumBrowsers, `${String(maxChromiumBrowsers)} renders to hold`);
        await waitFor(
          async () => (await browserProcesses()) === maxChromiumBrowsers,
          `${String(maxChromiumBrowsers)} browsers to run`,
        );
        expect(await sessionsServed()).toBe(maxChromiumBrowsers);
        const settled: number[] = [];
        for (const render of renders) {
          void render.then(
            () => settled.push(1),
            () => settled.push(1),
          );
        }
        await sleep(500);
        expect(settled).toEqual([]);

        releaseHold();
        const rendered = await Promise.all(renders);
        expect(rendered.map((page) => page.title)).toEqual(
          Array.from({ length: maxChromiumBrowsers + 2 }, () => "Slow page"),
        );
        expect(observed.filter((sessions) => sessions > maxChromiumBrowsers)).toEqual([]);
        expect(Math.max(...observed)).toBe(maxChromiumBrowsers);
        await waitFor(async () => (await browserProcesses()) === 0, "the browsers to close");
      } finally {
        sampling.done = true;
        await sampler;
      }
    },
    120_000,
  );

  it(
    "fails a render that waits past its 30-second deadline for a browser, and opens no connection for it",
    async () => {
      released = false;
      const holding = Array.from({ length: maxChromiumBrowsers }, () =>
        renderer.render(`${site}/slow`, { timeout: renderTimeout * 2 }),
      );
      await waitFor(() => held.length === maxChromiumBrowsers, `${String(maxChromiumBrowsers)} renders to hold`);

      const waiting = renderer.render(`${site}/slow`, { timeout: renderTimeout });
      await expect(waiting).rejects.toThrow(
        new Error(`${site}/slow didn't finish rendering within ${String(renderTimeout / 1000)} s`),
      );
      // It never reached the service: the renders that hold a browser are still the only ones, and
      // the page of the render that gave up was never asked for its script.
      expect(await sessionsServed()).toBe(maxChromiumBrowsers);
      expect(await browserProcesses()).toBe(maxChromiumBrowsers);
      expect(held).toHaveLength(maxChromiumBrowsers);

      releaseHold();
      await expect(Promise.all(holding)).resolves.toHaveLength(maxChromiumBrowsers);
      await waitFor(async () => (await browserProcesses()) === 0, "the browsers to close");
    },
    180_000,
  );

  it(
    "doesn't hold up a static poll while renders wait for a browser",
    async () => {
      released = false;
      const renders = Array.from({ length: maxChromiumBrowsers + 2 }, () =>
        renderer.render(`${site}/slow`, { timeout: 25_000 }),
      );
      await waitFor(() => held.length === maxChromiumBrowsers, `${String(maxChromiumBrowsers)} renders to hold`);
      const settled: number[] = [];
      for (const render of renders) {
        void render.then(
          () => settled.push(1),
          () => settled.push(1),
        );
      }
      await sleep(500);
      // Two renders are waiting for a browser, and neither has finished.
      expect(settled).toEqual([]);

      const started = Date.now();
      const response = await fetch(`${site}/status`);
      const elapsed = Date.now() - started;
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Loading…");
      expect(elapsed).toBeLessThan(2000);

      releaseHold();
      await Promise.all(renders);
    },
    120_000,
  );
});
