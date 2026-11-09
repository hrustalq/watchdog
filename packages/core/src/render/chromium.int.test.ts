import { createServer, type IncomingMessage } from "node:http";
import { GenericContainer, type StartedTestContainer, TestContainers, Wait } from "testcontainers";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { createEgressFetch } from "../egress/egress.ts";
import { createChromiumRenderer } from "./chromium.ts";

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
    fetch = createEgressFetch(config, { lookup });
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
});
