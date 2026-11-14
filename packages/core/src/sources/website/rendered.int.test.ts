import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { closeDb, createDb, type Db, eq, migrate, source, user, workspace } from "@watchdog/db";
import { startPostgres, type TestPostgres } from "@watchdog/db/testing";
import { fetch } from "undici";
import { GenericContainer, type StartedTestContainer, TestContainers, Wait } from "testcontainers";
import { beforeAll, describe, expect, it } from "vitest";
import { pollSource, type PollSourceDeps } from "../../pipeline/capture.ts";
import { createObscuraRenderer } from "../../render/obscura.ts";
import { renderTimeout } from "../../render/renderer.ts";

// A website Source rendered by the real Obscura image (docs: Sources and ingestion, "Renderers"). The
// pages come from a server in this process (docs: Testing and CI, "no live HTTP"): a status page whose
// text only its script writes, a page that fills the same Region from a fetch about a second after
// load, and a page that never answers.
const scripted = readFileSync(new URL("./fixtures/scripted.html", import.meta.url), "utf8");
const late = readFileSync(new URL("./fixtures/late.html", import.meta.url), "utf8");
const token = "a-test-token-of-at-least-thirty-two-bytes";
/** How long the late page's data takes to answer, well after its load event. */
const lateAnswer = 1000;

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
 * How long the render after another one waits for Obscura to free the closed session's slot. It is
 * long enough for a loaded machine to catch up, and a session that really leaked never frees its slot.
 */
const slotWait = 5000;
/** How often the wait tries again. */
const slotPoll = 100;

/** `Couldn't reach the Obscura renderer: … 503 Service Unavailable`: Obscura's one slot is taken. */
function outOfSlots(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith("Couldn't reach the Obscura renderer:") && error.message.includes("503");
}

/**
 * Obscura frees a closed session's slot a moment after the close returns, so under load the render
 * right after a timed-out or aborted one is refused with a 503 even though nothing leaked. Wait for
 * the slot instead of asserting on the first refusal; a session that leaked never frees it, so the
 * wait runs out and the 503 fails the test.
 */
async function renderWhenFree<T>(render: () => Promise<T>): Promise<T> {
  const until = Date.now() + slotWait;
  for (;;) {
    try {
      return await render();
    } catch (error) {
      if (!outOfSlots(error) || Date.now() >= until) throw error;
    }
    await sleep(slotPoll);
  }
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
      // The page's data, answering well after the page's load event.
      if (request.url?.startsWith("/late-data") === true) {
        const answer = () => response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("All systems operational");
        setTimeout(answer, lateAnswer);
        return;
      }
      if (request.url?.startsWith("/late") === true) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(late);
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

  async function newSource(render: "static" | "obscura", region?: string) {
    const [created] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "website",
        name: "Acme status",
        // Its own query, because a Workspace watches each page once.
        config: { url: `${site}/status?${crypto.randomUUID()}`, ignore: [], render, ...(region !== undefined && { region }) },
        schedule: "*/15 * * * *",
      })
      .returning();
    return present(created);
  }

  /** A Source of the page that fills its Region from a fetch answering about a second after load. */
  async function lateSource(region?: string) {
    const [created] = await db
      .insert(source)
      .values({
        workspaceId,
        type: "website",
        name: "Acme status",
        config: { url: `${site}/late?${crypto.randomUUID()}`, ignore: [], render: "obscura", ...(region !== undefined && { region }) },
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

  it("waits for a Region the page's script fills about a second after load, and reads the same text on every poll", async () => {
    const watching = await lateSource("#status");

    expect(await pollSource(db, watching.id, deps)).toEqual({ captured: 0 });
    const first = await reload(watching.id);
    expect(first.lastError).toBeNull();
    expect(first.fetchState.text).toBe("All systems operational");

    // A page read at its load event carries the skeleton, so a poll that saw it would capture a change.
    expect(await pollSource(db, watching.id, deps)).toEqual({ captured: 0 });
    expect((await reload(watching.id)).fetchState).toEqual(first.fetchState);
  });

  it("waits for the page without a Region to stand still after load, and reads the same text on every poll", async () => {
    const watching = await lateSource();

    expect(await pollSource(db, watching.id, deps)).toEqual({ captured: 0 });
    const first = await reload(watching.id);
    expect(first.lastError).toBeNull();
    expect(first.fetchState.text).toContain("All systems operational");

    // The same page read before its data arrives would hold only the skeleton, and capture it next time.
    expect(await pollSource(db, watching.id, deps)).toEqual({ captured: 0 });
    expect((await reload(watching.id)).fetchState).toEqual(first.fetchState);
  });

  it("fails a poll whose Region never appears within the render timeout, and leaves no CDP session open", async () => {
    // The page loads at once and never adds #missing, so the wait ends with the render's deadline.
    const watching = await lateSource("#missing");

    const started = Date.now();
    const failed = await pollSource(db, watching.id, deps);
    const elapsed = Date.now() - started;
    expect("error" in failed ? failed.error : "").toBe("The region #missing matched nothing on the page");
    expect(elapsed).toBeLessThan(renderTimeout);
    // It waited for the Region rather than failing at once, which is what reading at load would do.
    expect(elapsed).toBeGreaterThan(20_000);

    // Obscura takes one connection, so this render proves the last one was closed.
    const free = await renderWhenFree(() => renderer.render(`${site}/status`, { timeout: 10_000 }));
    expect(free.title).toBe("Acme status");
  }, 120_000);

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
    const free = await renderWhenFree(() => renderer.render(`${site}/status`, { timeout: 10_000 }));
    expect(free.title).toBe("Acme status");

    const stop = new AbortController();
    const aborted = renderer.render(`${site}/slow`, { timeout: 10_000, signal: stop.signal });
    setTimeout(() => {
      stop.abort();
    }, 300);
    await expect(aborted).rejects.toThrow();
    const after = await renderWhenFree(() => renderer.render(`${site}/status`, { timeout: 10_000 }));
    expect(after.finalUrl).toBe(`${site}/status`);
    expect(after.html).toContain("All systems operational");
  });
});
