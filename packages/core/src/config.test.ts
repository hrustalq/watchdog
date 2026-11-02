import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const minimal = {
  DATABASE_URL: "postgres://watchdog:watchdog@localhost:5432/watchdog",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
};

const smtp = {
  SMTP_HOST: "smtp.example.com",
  SMTP_USER: "watchdog",
  SMTP_PASSWORD: "password",
  SMTP_FROM: "Watchdog <watchdog@example.com>",
};

describe("loadConfig", () => {
  it("loads a minimal self-hosted env", () => {
    expect(loadConfig(minimal)).toMatchObject({
      mode: "self-hosted",
      databaseUrl: minimal.DATABASE_URL,
      auth: { secret: minimal.BETTER_AUTH_SECRET, url: minimal.BETTER_AUTH_URL },
      smtp: undefined,
      oauth: { google: undefined, github: undefined },
    });
  });

  it("loads .env.example as written", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    expect(loadConfig(parseEnv(example)).mode).toBe("self-hosted");
  });

  it("defaults the mode to self-hosted when WATCHDOG_MODE is unset", () => {
    expect(loadConfig(minimal).mode).toBe("self-hosted");
  });

  it("treats an empty variable as unset", () => {
    expect(loadConfig({ ...minimal, WATCHDOG_MODE: "", SMTP_HOST: "" })).toMatchObject({
      mode: "self-hosted",
      smtp: undefined,
    });
  });

  it("treats an undefined or blank variable as unset", () => {
    expect(loadConfig({ ...minimal, SMTP_HOST: undefined, SMTP_USER: "  " }).smtp).toBeUndefined();
  });

  it("trims values", () => {
    expect(loadConfig({ ...minimal, BETTER_AUTH_URL: " http://localhost:3000 " }).auth.url).toBe(
      "http://localhost:3000",
    );
  });

  it("does not turn SMTP on from SMTP_PORT alone", () => {
    expect(loadConfig({ ...minimal, SMTP_PORT: "2525" }).smtp).toBeUndefined();
  });

  it("uses SMTP_PORT when SMTP is on", () => {
    expect(loadConfig({ ...minimal, ...smtp, SMTP_PORT: "2525" }).smtp?.port).toBe(2525);
  });

  it("reports hosted mode without SMTP alongside other invalid variables", () => {
    expect(() => loadConfig({ WATCHDOG_MODE: "hosted" })).toThrow(/DATABASE_URL[\s\S]*SMTP_HOST/);
  });

  it("rejects an unknown mode and names WATCHDOG_MODE", () => {
    expect(() => loadConfig({ ...minimal, WATCHDOG_MODE: "foo" })).toThrow(/WATCHDOG_MODE/);
  });

  it("rejects a DATABASE_URL that isn't a Postgres URL", () => {
    expect(() => loadConfig({ ...minimal, DATABASE_URL: "not a url" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...minimal, DATABASE_URL: "https://example.com" })).toThrow(
      /DATABASE_URL/,
    );
  });

  it.each(["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"])("requires %s", (name) => {
    const env = Object.fromEntries(Object.entries(minimal).filter(([key]) => key !== name));
    expect(() => loadConfig(env)).toThrow(new RegExp(`${name}: is required`));
  });

  it("names every invalid variable in one message", () => {
    expect(() => loadConfig({ WATCHDOG_MODE: "foo" })).toThrow(
      /WATCHDOG_MODE[\s\S]*DATABASE_URL[\s\S]*BETTER_AUTH_SECRET[\s\S]*BETTER_AUTH_URL/,
    );
  });

  it("fails in hosted mode without SMTP_HOST", () => {
    expect(() => loadConfig({ ...minimal, WATCHDOG_MODE: "hosted" })).toThrow(/SMTP_HOST/);
  });

  it("loads hosted mode with SMTP, defaulting the port to 587", () => {
    expect(loadConfig({ ...minimal, ...smtp, WATCHDOG_MODE: "hosted" })).toMatchObject({
      mode: "hosted",
      smtp: {
        host: smtp.SMTP_HOST,
        port: 587,
        user: smtp.SMTP_USER,
        password: smtp.SMTP_PASSWORD,
        from: smtp.SMTP_FROM,
      },
    });
  });

  it("rejects a partly set SMTP group and names the missing variable", () => {
    const { SMTP_PASSWORD: _password, ...partial } = smtp;
    expect(() => loadConfig({ ...minimal, ...partial })).toThrow(/SMTP_PASSWORD/);
  });

  it("turns on an OAuth provider only when both its ID and secret are set", () => {
    expect(
      loadConfig({ ...minimal, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" }).oauth,
    ).toEqual({ google: undefined, github: { clientId: "id", clientSecret: "secret" } });
  });

  it("rejects half of an OAuth pair", () => {
    expect(() => loadConfig({ ...minimal, GOOGLE_CLIENT_ID: "id" })).toThrow(
      /GOOGLE_CLIENT_SECRET/,
    );
    expect(() => loadConfig({ ...minimal, GITHUB_CLIENT_SECRET: "secret" })).toThrow(
      /GITHUB_CLIENT_ID/,
    );
  });

  it("parses the variables of later milestones when present", () => {
    expect(
      loadConfig({
        ...minimal,
        WATCHDOG_ENCRYPTION_KEY: "key",
        TELEGRAM_BOT_TOKEN: "token",
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "hash",
        OBSCURA_CDP_URL: "ws://obscura:9222",
        OBSCURA_CDP_TOKEN: "cdp-token",
        EGRESS_ALLOWLIST: "10.0.0.5",
        GLITCHTIP_DSN: "https://key@glitchtip.example.com/1",
      }),
    ).toMatchObject({
      encryptionKey: "key",
      telegram: { botToken: "token", apiId: 12345, apiHash: "hash" },
      obscura: { cdpUrl: "ws://obscura:9222", cdpToken: "cdp-token" },
      egressAllowlist: "10.0.0.5",
      glitchtipDsn: "https://key@glitchtip.example.com/1",
    });
  });

  it("rejects a malformed optional variable", () => {
    expect(() => loadConfig({ ...minimal, TELEGRAM_API_ID: "abc" })).toThrow(/TELEGRAM_API_ID/);
    expect(() => loadConfig({ ...minimal, OBSCURA_CDP_URL: "localhost:9222" })).toThrow(
      /OBSCURA_CDP_URL/,
    );
    expect(() => loadConfig({ ...minimal, GLITCHTIP_DSN: "javascript:alert(1)" })).toThrow(
      /GLITCHTIP_DSN/,
    );
  });
});
