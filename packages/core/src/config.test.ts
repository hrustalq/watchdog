import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.ts";

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

  describe("with the .env.example file", () => {
    const example = parseEnv(readFileSync(new URL("../../../.env.example", import.meta.url), "utf8"));

    it("loads it as written, warning that its encryption key is public", () => {
      const warn = vi.fn();
      expect(loadConfig(example, warn).mode).toBe("self-hosted");
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/WATCHDOG_ENCRYPTION_KEY is the public placeholder/),
      );
    });

    it("refuses its encryption key in hosted mode", () => {
      expect(() => loadConfig({ ...example, ...smtp, WATCHDOG_MODE: "hosted" })).toThrow(
        /WATCHDOG_ENCRYPTION_KEY: must not be the placeholder/,
      );
    });
  });

  it("doesn't warn about a generated encryption key", () => {
    const warn = vi.fn();
    loadConfig(minimal, warn);
    expect(warn).not.toHaveBeenCalled();
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

  it("reads the alert sender address, which is absent unless it's set", () => {
    const alertFrom = "Watchdog alerts <alerts@example.com>";
    expect(loadConfig({ ...minimal, ...smtp, SMTP_ALERT_FROM: alertFrom }).smtp?.alertFrom).toBe(alertFrom);
    expect(loadConfig({ ...minimal, ...smtp }).smtp?.alertFrom).toBeUndefined();
  });

  it("refuses an alert sender address without the rest of SMTP", () => {
    expect(() => loadConfig({ ...minimal, SMTP_ALERT_FROM: "alerts@example.com" })).toThrow(/SMTP_ALERT_FROM/);
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

  it.each(["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL", "WATCHDOG_ENCRYPTION_KEY"])(
    "requires %s",
    (name) => {
      const env = Object.fromEntries(Object.entries(minimal).filter(([key]) => key !== name));
      expect(() => loadConfig(env)).toThrow(new RegExp(`${name}: is required`));
    },
  );

  it("requires WATCHDOG_ENCRYPTION_KEY in hosted mode too, and when it's blank", () => {
    const { WATCHDOG_ENCRYPTION_KEY: _key, ...withoutKey } = minimal;
    expect(() => loadConfig({ ...withoutKey, ...smtp, WATCHDOG_MODE: "hosted" })).toThrow(
      /WATCHDOG_ENCRYPTION_KEY: is required/,
    );
    expect(() => loadConfig({ ...minimal, WATCHDOG_ENCRYPTION_KEY: " " })).toThrow(
      /WATCHDOG_ENCRYPTION_KEY: is required/,
    );
  });

  it("decodes WATCHDOG_ENCRYPTION_KEY to its 32 bytes", () => {
    const encryptionKey = loadConfig({
      ...minimal,
      WATCHDOG_ENCRYPTION_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
    }).encryptionKey;
    expect(encryptionKey).toEqual(Buffer.alloc(32, 7));
  });

  it.each([
    ["31 bytes", `${"A".repeat(40)}AA==`],
    ["33 bytes", "A".repeat(44)],
    ["not base64", "!".repeat(44)],
    ["32 characters instead of 32 bytes", "a".repeat(32)],
    ["base64url", `${"_".repeat(43)}=`],
    ["unused bits set in its last character", `${"A".repeat(42)}B=`],
  ])("rejects a WATCHDOG_ENCRYPTION_KEY of %s without echoing it", (_label, value) => {
    const load = () => loadConfig({ ...minimal, WATCHDOG_ENCRYPTION_KEY: value });
    expect(load).toThrow(/WATCHDOG_ENCRYPTION_KEY: must be 32 bytes, base64-encoded/);
    expect(load).not.toThrow(value);
  });

  it("names every invalid variable in one message", () => {
    expect(() => loadConfig({ WATCHDOG_MODE: "foo" })).toThrow(
      /WATCHDOG_MODE[\s\S]*DATABASE_URL[\s\S]*BETTER_AUTH_SECRET[\s\S]*BETTER_AUTH_URL[\s\S]*WATCHDOG_ENCRYPTION_KEY/,
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
        TELEGRAM_BOT_TOKEN: "123456:AAH-token_value",
        TELEGRAM_API_ID: "12345",
        TELEGRAM_API_HASH: "hash",
        OBSCURA_CDP_URL: "ws://obscura:9222",
        OBSCURA_CDP_TOKEN: "cdp-token",
        EGRESS_ALLOWLIST: "10.0.0.5",
        GLITCHTIP_DSN: "https://key@glitchtip.example.com/1",
      }),
    ).toMatchObject({
      telegram: { botToken: "123456:AAH-token_value", api: { id: 12345, hash: "hash" } },
      obscura: { cdpUrl: "ws://obscura:9222", cdpToken: "cdp-token" },
      egressAllowlist: [{ type: "subnet", address: "10.0.0.5", prefix: 32, family: "ipv4" }],
      glitchtipDsn: "https://key@glitchtip.example.com/1",
    });
  });

  it.each(["a-secret-value", "123456", ":a-secret-value", "abc:a-secret-value", "123:a secret/value"])(
    "refuses TELEGRAM_BOT_TOKEN=%s, naming the variable without repeating its value",
    (value) => {
      const load = () => loadConfig({ ...minimal, TELEGRAM_BOT_TOKEN: value });
      expect(load).toThrow(/TELEGRAM_BOT_TOKEN: must look like <digits>:<token>/);
      expect(load).not.toThrow(value);
    },
  );

  it("treats a blank TELEGRAM_BOT_TOKEN as no bot", () => {
    expect(loadConfig({ ...minimal, TELEGRAM_BOT_TOKEN: "" }).telegram.botToken).toBeUndefined();
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

  it("reaches the Chromium renderer only when its URL and token are both set", () => {
    const token = "t".repeat(32);
    expect(loadConfig({ ...minimal, CHROMIUM_URL: "ws://chromium:3000", CHROMIUM_TOKEN: token }).chromium).toEqual({
      url: "ws://chromium:3000",
      token,
    });
    expect(loadConfig(minimal).chromium).toBeUndefined();
    expect(() => loadConfig({ ...minimal, CHROMIUM_URL: "ws://chromium:3000" })).toThrow(/CHROMIUM_TOKEN: is required/);
    expect(() => loadConfig({ ...minimal, CHROMIUM_TOKEN: token })).toThrow(/CHROMIUM_URL: is required/);
    expect(() => loadConfig({ ...minimal, CHROMIUM_URL: "http://chromium:3000", CHROMIUM_TOKEN: token })).toThrow(
      /CHROMIUM_URL: must be a ws:\/\/ or wss:\/\/ URL/,
    );
    const short = () => loadConfig({ ...minimal, CHROMIUM_URL: "ws://chromium:3000", CHROMIUM_TOKEN: "short-token" });
    expect(short).toThrow(/CHROMIUM_TOKEN: must be at least 32 characters/);
    expect(short).not.toThrow("short-token");
  });

  it("parses EGRESS_ALLOWLIST into hosts and subnets", () => {
    expect(
      loadConfig({ ...minimal, EGRESS_ALLOWLIST: "Ollama.local, 192.168.1.0/24,,fd00::1,10.0.0.0/8," })
        .egressAllowlist,
    ).toEqual([
      { type: "host", host: "ollama.local" },
      { type: "subnet", address: "192.168.1.0", prefix: 24, family: "ipv4" },
      { type: "subnet", address: "fd00::1", prefix: 128, family: "ipv6" },
      { type: "subnet", address: "10.0.0.0", prefix: 8, family: "ipv4" },
    ]);
    expect(loadConfig(minimal).egressAllowlist).toEqual([]);
  });

  const invalid = ["10.0.0.0/33", "fd00::/129", "10.0.0.0/", "10.0.0.0/8/8", "host/24", "host:11434"];
  it.each([...invalid, "a b", "*.local", "[fd00::1]"])(
    "rejects the EGRESS_ALLOWLIST entry %j and names the variable",
    (entry) => {
      expect(() => loadConfig({ ...minimal, EGRESS_ALLOWLIST: `ollama.local,${entry}` })).toThrow(
        /EGRESS_ALLOWLIST: ".*" is not a host, IP address or CIDR/,
      );
    },
  );

  it("warns at boot that hosted ignores EGRESS_ALLOWLIST", () => {
    const warn = vi.fn();
    const env = { ...minimal, ...smtp, WATCHDOG_MODE: "hosted", EGRESS_ALLOWLIST: "10.0.0.5" };
    loadConfig(env, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/EGRESS_ALLOWLIST is ignored/));
  });

  it("takes TELEGRAM_API_ID and TELEGRAM_API_HASH together or not at all", () => {
    expect(loadConfig(minimal).telegram.api).toBeUndefined();
    expect(() => loadConfig({ ...minimal, TELEGRAM_API_ID: "12345" })).toThrow(/TELEGRAM_API_HASH: is required/);
    expect(() => loadConfig({ ...minimal, TELEGRAM_API_HASH: "hash" })).toThrow(/TELEGRAM_API_ID: is required/);
  });

  it("ignores TELEGRAM_API_ID and TELEGRAM_API_HASH on hosted, with a warning at boot", () => {
    const warn = vi.fn();
    const env = { ...minimal, ...smtp, WATCHDOG_MODE: "hosted", TELEGRAM_API_ID: "12345", TELEGRAM_API_HASH: "hash" };
    expect(loadConfig(env, warn).telegram.api).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/TELEGRAM_API_ID and TELEGRAM_API_HASH are ignored/));
  });

  it("doesn't warn about EGRESS_ALLOWLIST on self-hosted or when it's unset", () => {
    const warn = vi.fn();
    loadConfig({ ...minimal, EGRESS_ALLOWLIST: "10.0.0.5" }, warn);
    loadConfig({ ...minimal, ...smtp, WATCHDOG_MODE: "hosted" }, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
