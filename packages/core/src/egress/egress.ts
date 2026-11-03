// The one way Watchdog fetches a URL it didn't write itself: RSS, static fetch, GitHub, the user's
// LLM base URL and webhook Actions. Ranges and allowlist format: "Network isolation" on the
// Security and privacy page and EGRESS_ALLOWLIST on the Configuration page in Knowledge.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { TransformStream } from "node:stream/web";
import { Agent, fetch, Headers, type RequestInit, Response } from "undici";
import type { Config } from "../config.ts";

/** One EGRESS_ALLOWLIST entry: a host name, or an IP address or CIDR as a subnet. */
export type EgressRule =
  | { type: "host"; host: string }
  | { type: "subnet"; address: string; prefix: number; family: "ipv4" | "ipv6" };

export class EgressBlockedError extends Error {
  override name = "EgressBlockedError";
  readonly host: string;
  readonly address: string | undefined;
  constructor(host: string, reason: string, address?: string) {
    super(`Watchdog doesn't fetch ${host}: ${reason}`);
    this.host = host;
    this.address = address;
  }
}

/** A request over the timeout or a response over the size cap. */
export class EgressLimitError extends Error {
  override name = "EgressLimitError";
}

export interface EgressOptions {
  /** Resolves a host name to every address it has. Tests inject one, so no test needs DNS. */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  timeoutMs?: number;
  maxBytes?: number;
}

const maxRedirects = 5;

const family = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4");

// BlockList also matches the IPv4-mapped IPv6 form (::ffff:a.b.c.d) of an IPv4 subnet.
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], // this network
  ["::", 128], // this network
  ["127.0.0.0", 8], // loopback
  ["::1", 128], // loopback
  ["10.0.0.0", 8], // private
  ["172.16.0.0", 12], // private
  ["192.168.0.0", 16], // private
  ["fc00::", 7], // private, with the fd00:ec2::254 metadata address
  ["100.64.0.0", 10], // CGNAT
  ["169.254.0.0", 16], // link-local, with the 169.254.169.254 metadata address
  ["fe80::", 10], // link-local
] as const) {
  blocked.addSubnet(address, prefix, family(address));
}

/** Parses one EGRESS_ALLOWLIST entry, or returns undefined when it's no host, IP or CIDR. */
export function parseEgressRule(entry: string): EgressRule | undefined {
  const [address = "", prefixText, ...rest] = entry.split("/");
  const version = isIP(address);
  if (version !== 0) {
    const max = version === 4 ? 32 : 128;
    const prefix = prefixText === undefined ? max : Number(prefixText);
    const valid = rest.length === 0 && (prefixText === undefined || /^\d+$/.test(prefixText));
    if (!valid || prefix > max) return undefined;
    return { type: "subnet", address, prefix, family: family(address) };
  }
  if (prefixText !== undefined) return undefined;
  // The URL parser rejects what isn't a host name, and rewrites what it reads as an IP or a port.
  const host = URL.parse(`http://${entry}`)?.hostname;
  return host === entry.toLowerCase() ? { type: "host", host } : undefined;
}

/**
 * Whether a request to `host` may connect to `address`. On self-hosted, EGRESS_ALLOWLIST lets
 * blocked addresses through. Hosted ignores it.
 */
export function egressPolicy(config: Pick<Config, "mode" | "egressAllowlist">) {
  const rules = config.mode === "hosted" ? [] : config.egressAllowlist;
  const hosts = new Set<string>();
  const allowed = new BlockList();
  for (const rule of rules) {
    if (rule.type === "host") hosts.add(rule.host);
    else allowed.addSubnet(rule.address, rule.prefix, rule.family);
  }
  return (host: string, address: string) =>
    !blocked.check(address, family(address)) ||
    hosts.has(host.toLowerCase()) ||
    allowed.check(address, family(address));
}

/**
 * A fetch that refuses blocked addresses. It checks the address the socket connects to, after DNS,
 * on every redirect, and limits each request's time and response size.
 */
export function createEgressFetch(
  config: Pick<Config, "mode" | "egressAllowlist">,
  {
    lookup = (host) => dnsLookup(host, { all: true }),
    timeoutMs = 30_000,
    maxBytes = 10 * 1024 * 1024,
  }: EgressOptions = {},
) {
  const allows = egressPolicy(config);
  const check = (host: string, address: string) => {
    if (!allows(host, address)) {
      throw new EgressBlockedError(host, `it resolves to the blocked address ${address}`, address);
    }
  };

  // The socket connects to an address this lookup returned, so a host can't pass the check with
  // one address and connect to another. Node skips the lookup for an IP literal, checked below.
  const connectLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname)
      .then((addresses) => {
        for (const { address } of addresses) check(hostname, address);
        const [first] = addresses;
        if (first === undefined) throw new Error(`${hostname} has no address`);
        if (options.all === true) callback(null, addresses);
        else callback(null, first.address, first.family);
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), "", 0);
      });
  };
  const dispatcher = new Agent({ connect: { lookup: connectLookup } });

  return async function egressFetch(input: string | URL, init: RequestInit = {}) {
    let url = new URL(input);
    let request = init;
    const timer = new AbortController();
    setTimeout(() => {
      timer.abort(new EgressLimitError(`${url.hostname} took longer than ${String(timeoutMs)} ms`));
    }, timeoutMs).unref();
    const signal = init.signal ? AbortSignal.any([init.signal, timer.signal]) : timer.signal;

    for (let redirects = 0; ; redirects++) {
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new EgressBlockedError(url.href, `only http and https URLs are fetched`);
      }
      const literal = url.hostname.replace(/^\[(.*)\]$/, "$1");
      if (isIP(literal) !== 0) check(literal, literal);

      let response;
      try {
        response = await fetch(url, { ...request, signal, dispatcher, redirect: "manual" });
      } catch (error) {
        // undici wraps a connect error as "fetch failed"; the guard's own error is the cause.
        const cause: unknown = error instanceof TypeError ? error.cause : undefined;
        throw cause instanceof EgressBlockedError ? cause : error;
      }

      const location = response.headers.get("location");
      if (response.status < 300 || response.status > 399 || location === null) {
        return capped(response, url, maxBytes);
      }
      await response.body?.cancel();
      if (redirects === maxRedirects) {
        const message = `${url.hostname} redirected more than ${String(maxRedirects)} times`;
        throw new EgressLimitError(message);
      }
      const next = new URL(location, url);
      // Like fetch's own redirects: a 303, or a POST answered with 301 or 302, continues as a GET.
      const { status } = response;
      const method = request.method?.toUpperCase();
      const toGet =
        status === 303 ? method !== "HEAD" : (status === 301 || status === 302) && method === "POST";
      if (toGet) {
        request = { ...request, method: "GET", body: null };
      }
      // Credentials don't follow a request to another origin either.
      if (next.origin !== url.origin) {
        const headers = new Headers(request.headers);
        headers.delete("authorization");
        headers.delete("cookie");
        request = { ...request, headers };
      }
      url = next;
    }
  };
}

function capped(response: Response, url: URL, maxBytes: number): Response {
  const tooBig = () =>
    new EgressLimitError(`${url.hostname} sent a response over ${String(maxBytes)} bytes`);
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel();
    throw tooBig();
  }
  if (response.body === null) return response;
  let size = 0;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) controller.error(tooBig());
        else controller.enqueue(chunk);
      },
    }),
  );
  const result = new Response(body, response);
  Object.defineProperty(result, "url", { value: url.href });
  return result;
}
