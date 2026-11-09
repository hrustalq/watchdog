import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

// The facts about Obscura that Watchdog's setup depends on (docs: Sources and ingestion, "Obscura").
const compose = z
  .object({
    services: z.object({
      obscura: z.object({ image: z.string(), command: z.array(z.string()), ports: z.unknown().optional() }),
    }),
  })
  .parse(parse(readFileSync(new URL("../../../../compose.yaml", import.meta.url), "utf8")));
const { obscura } = compose.services;

describe("Obscura in compose.yaml", () => {
  it("runs the public v0.2.6 image, which has no stealth, with stealth off", () => {
    expect(obscura.image).toBe("h4ckf0r0day/obscura:0.2.6");
    expect(obscura.command).not.toContain("--stealth");
  });

  it("keeps private-network blocking on and its CDP port off the host", () => {
    expect(obscura.command).not.toContain("--allow-private-network");
    expect(obscura.ports).toBeUndefined();
  });

  it("recycles its workers by memory and age, which takes more than one worker", () => {
    const flag = (name: string) => Number(obscura.command[obscura.command.indexOf(name) + 1]);
    expect(flag("--workers")).toBeGreaterThan(1);
    expect(flag("--worker-max-rss")).toBeGreaterThan(0);
    expect(flag("--worker-max-age")).toBeGreaterThan(0);
  });
});
