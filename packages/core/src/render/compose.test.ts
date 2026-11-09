import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

// The facts about Obscura and the Chromium fallback that Watchdog's setup depends on (docs: Sources and
// ingestion, "Obscura" and "The Chromium fallback").
const service = z.object({
  image: z.string().optional(),
  build: z.unknown().optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  ports: z.unknown().optional(),
  profiles: z.array(z.string()).optional(),
  networks: z.array(z.string()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
});
const compose = z
  .object({
    services: z.record(z.string(), service),
    networks: z.record(z.string(), z.object({ internal: z.boolean().optional() }).nullable()).optional(),
  })
  .parse(parse(read("compose.yaml")));
const { obscura, chromium } = compose.services;
const obscuraCommand = z.array(z.string()).parse(obscura?.command);

describe("Obscura in compose.yaml", () => {
  it("runs the public v0.2.6 image, which has no stealth, with stealth off", () => {
    expect(obscura?.image).toBe("h4ckf0r0day/obscura:0.2.6");
    expect(obscuraCommand).not.toContain("--stealth");
  });

  it("keeps private-network blocking on and its CDP port off the host", () => {
    expect(obscuraCommand).not.toContain("--allow-private-network");
    expect(obscura?.ports).toBeUndefined();
  });

  it("recycles its workers by memory and age, which takes more than one worker", () => {
    const flag = (name: string) => Number(obscuraCommand[obscuraCommand.indexOf(name) + 1]);
    expect(flag("--workers")).toBeGreaterThan(1);
    expect(flag("--worker-max-rss")).toBeGreaterThan(0);
    expect(flag("--worker-max-age")).toBeGreaterThan(0);
  });
});

describe("the Chromium fallback in compose.yaml", () => {
  it("starts only with the chromium profile, and gets only its token", () => {
    expect(chromium?.profiles).toEqual(["chromium"]);
    expect(Object.keys(chromium?.environment ?? {})).toEqual(["CHROMIUM_TOKEN"]);
  });

  it("sits on an internal network that only the worker shares, with no port on the host", () => {
    expect(chromium?.ports).toBeUndefined();
    expect(chromium?.networks).toEqual(["chromium"]);
    expect(compose.networks?.chromium?.internal).toBe(true);
    const sharing = Object.entries(compose.services).filter(([, other]) => other.networks?.includes("chromium"));
    expect(sharing.map(([name]) => name).sort()).toEqual(["chromium", "worker"]);
  });

  it("runs Playwright's browser server at the version of playwright-core the worker connects with", () => {
    const core = z
      .object({ dependencies: z.object({ "playwright-core": z.string() }) })
      .parse(JSON.parse(read("packages/core/package.json")));
    const version = core.dependencies["playwright-core"];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const dockerfile = read(`${z.string().parse(chromium?.build)}/Dockerfile`);
    expect(dockerfile).toContain(`FROM mcr.microsoft.com/playwright:v${version}-`);
    expect(dockerfile).toContain(`playwright-core@${version}`);
    // Clients may not pass launch flags such as --no-sandbox or a proxy.
    expect(dockerfile).not.toContain("--unsafe");
  });
});
