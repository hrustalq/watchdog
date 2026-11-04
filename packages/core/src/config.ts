// The one place that reads the environment. Every variable here is listed on the Configuration
// page in Knowledge (docs/watchdog/architecture/configuration.md) and in .env.example.
import { z } from "zod";
import { parseEgressRule, type EgressRule } from "./egress/egress.ts";

// A schema's own message would also replace "is required" for a missing variable.
const invalid = (message: string) => (issue: { input: unknown }) =>
  issue.input === undefined ? "is required" : message;

// Variables that only work together are parsed as a group: absent when none is set, and an
// error naming the missing ones when only some are.
const groups = {
  smtp: ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"],
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  github: ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
} as const;

const oauth = (id: string, secret: string) => ({ clientId: id, clientSecret: secret });

const schema = z
  .object({
    WATCHDOG_MODE: z.enum(["self-hosted", "hosted"]).default("self-hosted"),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: invalid("must be a postgres:// URL") }),
    BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
    BETTER_AUTH_URL: z.url({ protocol: /^https?$/, error: invalid("must be an http(s) URL") }),
    // Decoding alone accepts stray characters and base64url, so the key must re-encode to itself.
    WATCHDOG_ENCRYPTION_KEY: z.string().transform((value, ctx) => {
      const key = Buffer.from(value, "base64");
      if (key.length === 32 && key.toString("base64") === value) return key;
      ctx.addIssue({ code: "custom", message: "must be 32 bytes, base64-encoded" });
      return z.NEVER;
    }),
    smtp: z
      .object({
        SMTP_HOST: z.string(),
        SMTP_USER: z.string(),
        SMTP_PASSWORD: z.string(),
        SMTP_FROM: z.string(),
      })
      .optional(),
    // Not in the SMTP group: a port alone doesn't turn mail on.
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    google: z.object({ GOOGLE_CLIENT_ID: z.string(), GOOGLE_CLIENT_SECRET: z.string() }).optional(),
    github: z.object({ GITHUB_CLIENT_ID: z.string(), GITHUB_CLIENT_SECRET: z.string() }).optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_API_ID: z.coerce.number().int().positive().optional(),
    TELEGRAM_API_HASH: z.string().optional(),
    OBSCURA_CDP_URL: z.url({ protocol: /^(wss?|https?)$/ }).optional(),
    OBSCURA_CDP_TOKEN: z.string().optional(),
    // Comma-separated hosts, IP addresses and CIDRs, e.g. `ollama.local,192.168.1.0/24`.
    EGRESS_ALLOWLIST: z
      .string()
      .optional()
      .transform((value, ctx) => {
        const rules: EgressRule[] = [];
        for (const entry of value?.split(",").map((part) => part.trim()) ?? []) {
          if (entry === "") continue;
          const rule = parseEgressRule(entry);
          const message = `"${entry}" is not a host, IP address or CIDR`;
          if (rule) rules.push(rule);
          else ctx.addIssue({ code: "custom", message });
        }
        return rules;
      }),
    GLITCHTIP_DSN: z.url({ protocol: /^https?$/ }).optional(),
  })
  .refine((env) => env.WATCHDOG_MODE !== "hosted" || env.smtp !== undefined, {
    path: ["SMTP_HOST"],
    error: "is required when WATCHDOG_MODE=hosted, with SMTP_USER, SMTP_PASSWORD and SMTP_FROM",
    // Run even when other variables are invalid, so one start reports every problem.
    when: (payload) =>
      payload.issues.every((issue) => !["WATCHDOG_MODE", "smtp"].includes(String(issue.path?.[0]))),
  })
  .transform((env) => ({
    mode: env.WATCHDOG_MODE,
    databaseUrl: env.DATABASE_URL,
    auth: { secret: env.BETTER_AUTH_SECRET, url: env.BETTER_AUTH_URL },
    encryptionKey: env.WATCHDOG_ENCRYPTION_KEY,
    smtp: env.smtp && {
      host: env.smtp.SMTP_HOST,
      port: env.SMTP_PORT,
      user: env.smtp.SMTP_USER,
      password: env.smtp.SMTP_PASSWORD,
      from: env.smtp.SMTP_FROM,
    },
    oauth: {
      google: env.google && oauth(env.google.GOOGLE_CLIENT_ID, env.google.GOOGLE_CLIENT_SECRET),
      github: env.github && oauth(env.github.GITHUB_CLIENT_ID, env.github.GITHUB_CLIENT_SECRET),
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
    },
    obscura: { cdpUrl: env.OBSCURA_CDP_URL, cdpToken: env.OBSCURA_CDP_TOKEN },
    egressAllowlist: env.EGRESS_ALLOWLIST,
    glitchtipDsn: env.GLITCHTIP_DSN,
  }));

export type Config = z.output<typeof schema>;

/** Parses the environment, or throws an error that names every invalid variable. */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  warn = (message: string): void => {
    process.stderr.write(`${message}\n`);
  },
): Config {
  // Values are trimmed, and a blank one (`SMTP_HOST=` copied from .env.example) means unset.
  const set: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    if (trimmed !== undefined && trimmed !== "") set[name] = trimmed;
  }
  const input: Record<string, unknown> = { ...set };
  for (const [group, names] of Object.entries(groups)) {
    const present = names.filter((name) => name in set);
    input[group] =
      present.length === 0 ? undefined : Object.fromEntries(present.map((n) => [n, set[n]]));
  }

  const result = schema.safeParse(input, {
    error: (issue) => (issue.input === undefined ? "is required" : undefined),
  });
  if (result.success) {
    if (result.data.mode === "hosted" && result.data.egressAllowlist.length > 0) {
      warn(
        "EGRESS_ALLOWLIST is ignored when WATCHDOG_MODE=hosted: the egress guard lets no private addresses through.",
      );
    }
    return result.data;
  }

  // A grouped variable's path is [group, name]; the variable's own name is what people set.
  const lines = result.error.issues.map((issue) => `  ${String(issue.path.at(-1))}: ${issue.message}`);
  throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
}
