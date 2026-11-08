import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import {
  createEgressFetch,
  EgressBlockedError,
  EgressLimitError,
  egressPolicy,
  type EgressOptions,
} from "./egress.ts";

const minimal = {
  DATABASE_URL: "postgres://watchdog:watchdog@localhost:5432/watchdog",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  WATCHDOG_ENCRYPTION_KEY: "A".repeat(43) + "=",
};
const smtp = {
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "watchdog",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "Watchdog <watchdog@example.com>",
};
const quiet = () => undefined;
const selfHosted = (allowlist?: string) =>
  loadConfig({ ...minimal, EGRESS_ALLOWLIST: allowlist }, quiet);
const hosted = (allowlist?: string) =>
  loadConfig({ ...minimal, ...smtp, WATCHDOG_MODE: "hosted", EGRESS_ALLOWLIST: allowlist }, quiet);

// No real DNS: every test host resolves through this table.
const dns: Record<string, string> = {
  "public.test": "127.0.0.1",
  "other.test": "127.0.0.1",
};
const lookup: EgressOptions["lookup"] = (hostname) => {
  const address = dns[hostname];
  return Promise.resolve(
    address === undefined ? [] : [{ address, family: address.includes(":") ? 6 : 4 }],
  );
};

// A local server stands in for the internet. It is on 127.0.0.1, so tests that reach it
// allowlist `public.test` and `other.test` on self-hosted; 127.0.0.1 itself stays blocked.
const requests: IncomingMessage[] = [];
let connections = 0;
let server: Server;
let port: number;
const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void> = {
  "/ok": (_req, res) => res.end("ok"),
  "/to-loopback": (_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${String(port)}/ok` }).end();
  },
  "/to-private-host": (_req, res) => {
    res.writeHead(302, { location: `http://internal.test:${String(port)}/ok` }).end();
  },
  "/to-ftp": (_req, res) => res.writeHead(302, { location: "ftp://public.test/feed" }).end(),
  "/to-other": (_req, res) => {
    res.writeHead(307, { location: `http://other.test:${String(port)}/ok` }).end();
  },
  "/see-other": (_req, res) => res.writeHead(303, { location: "/ok" }).end(),
  "/never": () => undefined,
  "/stalls": (_req, res) => res.write("partial"),
  "/big": (_req, res) => res.end("x".repeat(2048)),
  "/big-streamed": (_req, res) => {
    res.write("x".repeat(800));
    res.end("x".repeat(800));
  },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push(req);
    const hops = /^\/hops\/(\d+)$/.exec(req.url ?? "")?.[1];
    if (hops !== undefined) {
      if (hops === "0") res.end("done");
      else res.writeHead(302, { location: `/hops/${String(Number(hops) - 1)}` }).end();
      return;
    }
    (routes[req.url ?? ""] ?? ((_req, r) => r.writeHead(404).end()))(req, res);
  });
  server.on("connection", () => connections++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  port = address.port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const reach = (path: string, host = "public.test") => `http://${host}:${String(port)}${path}`;
const open = () => createEgressFetch(selfHosted("public.test,other.test"), { lookup });

const blocked = [
  ["loopback", "127.0.0.1"],
  ["loopback", "127.255.255.254"],
  ["loopback", "::1"],
  ["private", "10.0.0.1"],
  ["private", "172.16.0.1"],
  ["private", "172.31.255.255"],
  ["private", "192.168.1.10"],
  ["private", "fc00::1"],
  ["private", "fd12:3456::1"],
  ["link-local", "169.254.1.1"],
  ["link-local", "fe80::1"],
  ["metadata", "169.254.169.254"],
  ["metadata", "fd00:ec2::254"],
  ["this network", "0.0.0.0"],
  ["this network", "0.1.2.3"],
  ["this network", "::"],
  ["CGNAT", "100.64.0.1"],
  ["CGNAT", "100.127.255.255"],
  ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
  ["IPv4-mapped private", "::ffff:10.0.0.1"],
  ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
  ["IPv4-mapped CGNAT", "::ffff:100.64.0.1"],
  ["IPv4-compatible loopback", "::7f00:1"],
  ["NAT64 metadata", "64:ff9b::a9fe:a9fe"],
  ["NAT64 loopback", "64:ff9b::7f00:1"],
  ["NAT64 this network", "64:ff9b::"],
  ["local-use NAT64", "64:ff9b:1::1"],
  ["6to4", "2002:a9fe:a9fe::1"],
  ["IETF protocol assignments", "192.0.0.1"],
  ["benchmarking", "198.18.0.1"],
  ["multicast", "224.0.0.1"],
  ["multicast", "ff02::1"],
  ["reserved", "240.0.0.1"],
  ["broadcast", "255.255.255.255"],
] as const;

describe("egressPolicy", () => {
  it.each(blocked)("blocks %s %s in both modes", (_range, address) => {
    expect(egressPolicy(selfHosted())("host.test", address)).toBe(false);
    expect(egressPolicy(hosted())("host.test", address)).toBe(false);
  });

  const publicAddresses = [
    ...["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "198.20.0.1", "223.255.255.255"],
    ...["2606:4700::1", "64:ff9b::808:808", "64:ff9b::5db8:d822"],
  ];
  it.each(publicAddresses)(
    "lets the public address %s through",
    (address) => {
      expect(egressPolicy(hosted())("example.com", address)).toBe(true);
    },
  );

  it("lets an allowlisted CIDR through on self-hosted and not on hosted", () => {
    expect(egressPolicy(selfHosted("192.168.1.0/24"))("192.168.1.10", "192.168.1.10")).toBe(true);
    expect(egressPolicy(selfHosted("192.168.1.0/24"))("192.168.2.10", "192.168.2.10")).toBe(false);
    expect(egressPolicy(hosted("192.168.1.0/24"))("192.168.1.10", "192.168.1.10")).toBe(false);
  });

  it("lets an allowlisted CIDR through behind NAT64 too", () => {
    expect(egressPolicy(selfHosted("10.0.0.0/8"))("ollama.test", "64:ff9b::a00:5")).toBe(true);
  });

  it("lets an allowlisted host through whatever it resolves to, on self-hosted only", () => {
    expect(egressPolicy(selfHosted("ollama.local"))("ollama.local", "192.168.1.5")).toBe(true);
    expect(egressPolicy(selfHosted("ollama.local"))("Ollama.Local", "192.168.1.5")).toBe(true);
    expect(egressPolicy(selfHosted("ollama.local"))("other.local", "192.168.1.5")).toBe(false);
    expect(egressPolicy(hosted("ollama.local"))("ollama.local", "192.168.1.5")).toBe(false);
  });
});

describe("createEgressFetch", () => {
  it.each(blocked)(
    "refuses a host that resolves to %s %s before connecting, in both modes",
    async (_range, address) => {
      dns["internal.test"] = address;
      const before = connections;
      for (const config of [selfHosted(), hosted()]) {
        const fetch = createEgressFetch(config, { lookup });
        const error = await fetch(reach("/ok", "internal.test")).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(EgressBlockedError);
        expect(error).toMatchObject({ host: "internal.test", address });
      }
      expect(connections).toBe(before);
    },
  );

  it.each(blocked)("refuses the IP literal of %s %s", async (_range, address) => {
    const host = address.includes(":") ? `[${address}]` : address;
    const error = await createEgressFetch(hosted())(reach("/ok", host)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EgressBlockedError);
    // The URL parser writes an IPv4-mapped address in hex: ::ffff:127.0.0.1 is ::ffff:7f00:1.
    const normalized = new URL(`http://${host}/`).hostname.replace(/^\[|\]$/g, "");
    expect(error).toMatchObject({ address: normalized });
  });

  it("refuses a host with any blocked address among its records", async () => {
    const fetch = createEgressFetch(hosted(), {
      lookup: () =>
        Promise.resolve([
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ]),
    });
    await expect(fetch("http://mixed.test/")).rejects.toMatchObject({ address: "10.0.0.1" });
  });

  it("fetches an allowlisted host on self-hosted", async () => {
    const response = await open()(reach("/ok"));
    expect(await response.text()).toBe("ok");
  });

  it("names Watchdog and its version in the User-Agent when the caller sets none", async () => {
    const before = requests.length;
    // Through a redirect to another origin, so robots.txt there sees Watchdog too.
    await open()(reach("/to-other"));
    const sent = requests.slice(before).map((r) => r.headers["user-agent"]);
    expect(sent).toHaveLength(2);
    for (const userAgent of sent) {
      expect(userAgent).toMatch(
        /^Watchdog\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/hrustalq\/watchdog\)$/,
      );
    }
  });

  it("sends the caller's own User-Agent, across a redirect to another origin too", async () => {
    const before = requests.length;
    await open()(reach("/to-other"), { headers: { "User-Agent": "Custom/1" } });
    const sent = requests.slice(before).map((r) => r.headers["user-agent"]);
    expect(sent).toEqual(["Custom/1", "Custom/1"]);
  });

  it("fetches an allowlisted address on self-hosted and refuses it on hosted", async () => {
    const response = await createEgressFetch(selfHosted("127.0.0.1"))(reach("/ok", "127.0.0.1"));
    expect(await response.text()).toBe("ok");
    await expect(
      createEgressFetch(hosted("127.0.0.1"))(reach("/ok", "127.0.0.1")),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("refuses a redirect to http://127.0.0.1/ at the redirect", async () => {
    const before = requests.length;
    const error = await open()(reach("/to-loopback")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EgressBlockedError);
    expect(error).toMatchObject({ host: "127.0.0.1", address: "127.0.0.1" });
    expect(requests.slice(before).map((r) => r.url)).toEqual(["/to-loopback"]);
  });

  it("refuses a redirect to a host that resolves to a private address", async () => {
    dns["internal.test"] = "10.0.0.1";
    await expect(open()(reach("/to-private-host"))).rejects.toMatchObject({
      host: "internal.test",
      address: "10.0.0.1",
    });
  });

  it("follows up to 5 redirects and reports where it ended", async () => {
    const response = await open()(reach("/hops/5"));
    expect(await response.text()).toBe("done");
    expect(response.url).toBe(reach("/hops/0"));
  });

  it("fails on the 6th redirect", async () => {
    await expect(open()(reach("/hops/6"))).rejects.toThrow(EgressLimitError);
  });

  it("only fetches http and https, on the first request and on redirects", async () => {
    await expect(open()("file:///etc/passwd")).rejects.toThrow(EgressBlockedError);
    await expect(open()(reach("/to-ftp"))).rejects.toThrow(EgressBlockedError);
  });

  it("keeps only headers without credentials on a redirect to another origin", async () => {
    const before = requests.length;
    const validators = {
      "if-none-match": '"v1"',
      "if-modified-since": "Mon, 02 Nov 2026 00:00:00 GMT",
    };
    const headers = { authorization: "Bearer secret", "x-api-key": "secret", accept: "text/xml" };
    await open()(reach("/to-other"), { headers: { ...headers, ...validators } });
    const [first, second] = requests.slice(before).map((r) => r.headers);
    expect(first).toMatchObject(headers);
    // Conditional-request validators carry no credentials, so a feed moved to https keeps its 304s.
    expect(second).toMatchObject({ accept: "text/xml", ...validators });
    expect(second).not.toHaveProperty("authorization");
    expect(second).not.toHaveProperty("x-api-key");
  });

  it("turns a POST into a GET without its body headers on a 303", async () => {
    const before = requests.length;
    const headers = { "content-type": "application/json", "x-trace": "1" };
    await open()(reach("/see-other"), { method: "POST", body: "{}", headers });
    const [post, get] = requests.slice(before);
    expect([post?.method, get?.method]).toEqual(["POST", "GET"]);
    expect(get?.headers).not.toHaveProperty("content-type");
    expect(get?.headers).toMatchObject({ "x-trace": "1" });
  });

  it("fails a request with no response within the timeout", async () => {
    const fetch = createEgressFetch(selfHosted("public.test"), { lookup, timeoutMs: 100 });
    await expect(fetch(reach("/never"))).rejects.toThrow(
      new EgressLimitError("public.test took longer than 100 ms"),
    );
  });

  it("fails reading a body that is still incomplete at the timeout", async () => {
    // Long enough for the headers to arrive on a loaded runner, so the timer fires during the body.
    const fetch = createEgressFetch(selfHosted("public.test"), { lookup, timeoutMs: 2_000 });
    const response = await fetch(reach("/stalls"));
    await expect(response.text()).rejects.toThrow(EgressLimitError);
  });

  it("fails a response whose declared size is over the cap", async () => {
    const fetch = createEgressFetch(selfHosted("public.test"), { lookup, maxBytes: 1024 });
    await expect(fetch(reach("/big"))).rejects.toThrow(
      new EgressLimitError("public.test sent a response over 1024 bytes"),
    );
  });

  it("fails reading a streamed body once it passes the cap", async () => {
    const fetch = createEgressFetch(selfHosted("public.test"), { lookup, maxBytes: 1024 });
    const response = await fetch(reach("/big-streamed"));
    await expect(response.text()).rejects.toThrow(EgressLimitError);
  });

  it("passes a body under the cap through whole", async () => {
    const fetch = createEgressFetch(selfHosted("public.test"), { lookup, maxBytes: 2048 });
    expect((await (await fetch(reach("/big"))).text()).length).toBe(2048);
  });
});
