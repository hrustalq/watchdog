import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { closeDb, createDb, type Db, eq, migrate, source, user, workspace } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { fetch } from "undici";
import { GenericContainer, type StartedTestContainer, TestContainers, Wait } from "testcontainers";
import { beforeAll, describe, expect, it } from "vitest";
import { pollSource, type PollSourceDeps } from "../../pipeline/capture.ts";
import { createObscuraRenderer } from "../../render/obscura.ts";

// A website Source rendered by the real Obscura image (docs: Sources and ingestion, "Renderers"). The
// pages come from a server in this process (docs: Testing and CI, "no live HTTP"): a status page whose
// text only its script writes, and a page that never answers.
const scripted = readFileSync(new URL("./fixtures/scripted.html", import.meta.url), "utf8");
const token = "a-test-token-of-at-least-thirty-two-bytes";

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value");
  return value;
}

/** Starts the server on a free port and returns the port. */
async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The server has no port");
  return address.port;
}

async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Obscura as compose.yaml runs it, with two changes. It may fetch private addresses, so it reaches the
 * server on this machine. It takes one connection at most, so a CDP session left open refuses the next
 * one: its /json/list always lists one blank page, so it can't show an open session. It listens on the
 * same port inside and out, because it refuses a Host header that names any other port.
 */
function startObscura(port: number) {
  return new GenericContainer("h4ckf0r0day/obscura:0.2.6")
    .withEnvironment({ OBSCURA_CDP_TOKEN: token })
    .withCommand(["serve", "--port", String(port), "--host", "0.0.0.0", "--allow-private-network", "--max-connections", "1"])
    .withExposedPorts({ container: port, host: port })
    // The image has no shell for a port check.
    .withWaitStrategy(Wait.forLogMessage("CDP server"))
    .start();
}

describe("rendered website Sources", () => {
  let postgres: TestPostgres;
  let db: Db;
  let workspaceId: string;
  let obscura: StartedTestContainer;
  let cdpPort: number;
  /** The fixture server as Obscura's container reaches it. */
  let site: string;
  let deps: PollSourceDeps;
  let renderer: ReturnType<typeof createObscuraRenderer>;

  beforeAll(async () => {
    const server = createServer((request, response) => {
      // Left open: the render has to time out.
      if (request.url === "/slow") return;
      if (request.url?.startsWith("/status") === true) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(scripted);
        return;
      }
      response.writeHead(404).end("Not found");
    });
    const port = await listen(server);
    await TestContainers.exposeHostPorts(port);
    site = `http://host.testcontainers.internal:${String(port)}`;

    cdpPort = await freePort();
    [postgres, obscura] = await Promise.all([startPostgres(), startObscura(cdpPort)]);
    await migrate(postgres.url);
    db = createDb(postgres.url);
    await db.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
    const [ws] = await db.insert(workspace).values({ name: "Workspace", ownerUserId: "owner" }).returning();
    workspaceId = present(ws).id;

    renderer = createObscuraRenderer({ cdpUrl: `ws://localhost:${String(cdpPort)}`, cdpToken: token });
    deps = {
      // The static fetch reaches the same server from this machine.
      fetch: (input, init) => fetch(String(input).replace("host.testcontainers.internal", "127.0.0.1"), init),
      enqueueItems: () => Promise.resolve(),
      secrets: { encryptionKey: Buffer.alloc(32), authSecret: "unused-by-website-sources" },
      mode: "hosted",
      obscura: renderer,
    };
    return async () => {
      server.closeAllConnections();
      server.close();
      await closeDb(db);
      await Promise.all([postgres.stop(), obscura.stop()]);
    };
  }, 180_000);

  async function newSource(render: "static" | "obscura") {
    const [created] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "website",
        name: "Acme status",
        // Its own query, because a Workspace watches each page once.
        config: { url: `${site}/status?${crypto.randomUUID()}`, ignore: [], render },
        schedule: "*/15 * * * *",
      })
      .returning();
    return present(created);
  }

  const reload = async (sourceId: string) =>
    present(await db.query.source.findFirst({ where: eq(source.id, sourceId) }));

  it("sees text that only the page's script writes, which the static fetch doesn't", async () => {
    const rendered = await newSource("obscura");
    const plain = await newSource("static");

    expect(await pollSource(db, rendered.id, deps)).toEqual({ captured: 0 });
    expect(await pollSource(db, plain.id, deps)).toEqual({ captured: 0 });

    const renderedState = await reload(rendered.id);
    expect(renderedState.lastError).toBeNull();
    expect(renderedState.fetchState.text).toBe("All systems operational");
    const plainState = await reload(plain.id);
    expect(plainState.lastError).toBeNull();
    expect(plainState.fetchState.text).toBe("Loading…");
  });

  it("fails a poll with a readable error while Obscura is down, and succeeds once it is back", async () => {
    const rendered = await newSource("obscura");
    await obscura.stop();

    const failed = await pollSource(db, rendered.id, deps);
    const error = "error" in failed ? failed.error : "";
    expect(error).toMatch(/^Couldn't reach the Obscura renderer: .*ECONNREFUSED/);
    expect((await reload(rendered.id)).lastError).toBe(error);

    obscura = await startObscura(cdpPort);
    expect(await pollSource(db, rendered.id, deps)).toEqual({ captured: 0 });
    const recovered = await reload(rendered.id);
    expect(recovered.lastError).toBeNull();
    expect(recovered.fetchState.text).toBe("All systems operational");
  });

  it("leaves no CDP session open after a timeout or an abort", async () => {
    await expect(renderer.render(`${site}/slow`, { timeout: 1000 })).rejects.toThrow(
      `${site}/slow didn't finish rendering within 1 s`,
    );
    // Obscura takes one connection, so this render proves the last one was closed.
    expect((await renderer.render(`${site}/status`, { timeout: 10_000 })).title).toBe("Acme status");

    const stop = new AbortController();
    const aborted = renderer.render(`${site}/slow`, { timeout: 10_000, signal: stop.signal });
    setTimeout(() => {
      stop.abort();
    }, 300);
    await expect(aborted).rejects.toThrow();
    const after = await renderer.render(`${site}/status`, { timeout: 10_000 });
    expect(after.finalUrl).toBe(`${site}/status`);
    expect(after.html).toContain("All systems operational");
  });
});
