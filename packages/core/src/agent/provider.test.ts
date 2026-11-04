import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressLimitError, parseEgressRule } from "../egress/egress.ts";
import { createAgentFetch } from "./provider.ts";

describe("createAgentFetch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a slow model 120 seconds, past the guard's default 30", async () => {
    const rule = parseEgressRule("127.0.0.1");
    if (rule === undefined) throw new Error("Expected a rule");
    const { promise: requestSeen, resolve } = Promise.withResolvers<null>();
    // The server takes the request and never answers.
    const server = createServer(() => {
      resolve(null);
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a port");
    const { port } = address;

    try {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      const fetch = createAgentFetch({ mode: "self-hosted", egressAllowlist: [rule] });
      let settled = false;
      const outcome = fetch(`http://127.0.0.1:${String(port)}/`)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await requestSeen;

      await vi.advanceTimersByTimeAsync(119_000);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_001);
      expect(await outcome).toBeInstanceOf(EgressLimitError);
    } finally {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    }
  });
});
