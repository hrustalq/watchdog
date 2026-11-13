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
  chromium: ["CHROMIUM_URL", "CHROMIUM_TOKEN"],
  telegramApi: ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"],
} as const;

const oauth = (id: string, secret: string) => ({ clientId: id, clientSecret: secret });

/** The variables that only a hosted install's rule limits use: self-hosted ignores them and warns. */
const hostedLimitNames = [
  "HOSTED_MAX_RULE_INSTRUCTIONS",
  "HOSTED_MAX_RULES",
  "HOSTED_MAX_RULE_JSONPATH_FIELDS",
  "HOSTED_MAX_JSONPATH_NODES",
];

const hostedLimitsSet = (input: Record<string, unknown>) =>
  hostedLimitNames.some((name) => input[name] !== undefined);

// The key in .env.example, which lets a copied file start the stack. It's public, so it protects
// nothing, and a secret stored under it can't move to a real key without being entered again.
const placeholderKey = Buffer.from("replace-with-32-random-key-bytes");

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
    // Not in the SMTP group either: it's optional within it.
    SMTP_ALERT_FROM: z.string().optional(),
    google: z.object({ GOOGLE_CLIENT_ID: z.string(), GOOGLE_CLIENT_SECRET: z.string() }).optional(),
    github: z.object({ GITHUB_CLIENT_ID: z.string(), GITHUB_CLIENT_SECRET: z.string() }).optional(),
    // Goes into the Bot API's URL. The message can't repeat the value, which is a credential.
    TELEGRAM_BOT_TOKEN: z
      .string()
      .regex(/^\d+:[\w-]+$/, "must look like <digits>:<token>, as BotFather gives it")
      .optional(),
    telegramApi: z
      .object({
        TELEGRAM_API_ID: z.string().regex(/^[1-9]\d*$/, "must be a whole number").transform(Number),
        TELEGRAM_API_HASH: z.string(),
      })
      .optional(),
    OBSCURA_CDP_URL: z.url({ protocol: /^(wss?|https?)$/ }).optional(),
    OBSCURA_CDP_TOKEN: z.string().optional(),
    // The worker sends the token as a Bearer header. The message can't repeat it.
    chromium: z
      .object({
        CHROMIUM_URL: z.url({ protocol: /^wss?$/, error: invalid("must be a ws:// or wss:// URL") }),
        CHROMIUM_TOKEN: z.string().min(32, "must be at least 32 characters"),
      })
      .optional(),
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
    // The hosted plan's per-Workspace rule limits (docs: Business model and licensing). Hosted
    // enforces them on a save and on an enable; self-hosted sets no limit. A JSONPath field that can
    // fan out costs nodes, not bytes, so 50,000 nodes is about 50 of the slowest path measured
    // (2.6 s on node:26-alpine), and a bigger payload is refused rather than walked.
    HOSTED_MAX_RULE_INSTRUCTIONS: z.coerce.number().int().positive().default(5000),
    HOSTED_MAX_RULES: z.coerce.number().int().positive().default(100),
    HOSTED_MAX_RULE_JSONPATH_FIELDS: z.coerce.number().int().positive().default(50),
    HOSTED_MAX_JSONPATH_NODES: z.coerce.number().int().positive().default(50_000),
    GLITCHTIP_DSN: z.url({ protocol: /^https?$/ }).optional(),
  })
  .refine((env) => env.WATCHDOG_MODE !== "hosted" || env.smtp !== undefined, {
    path: ["SMTP_HOST"],
    error: "is required when WATCHDOG_MODE=hosted, with SMTP_USER, SMTP_PASSWORD and SMTP_FROM",
    // Run even when other variables are invalid, so one start reports every problem.
    when: (payload) =>
      payload.issues.every((issue) => !["WATCHDOG_MODE", "smtp"].includes(String(issue.path?.[0]))),
  })
  .refine((env) => env.SMTP_ALERT_FROM === undefined || env.smtp !== undefined, {
    path: ["SMTP_ALERT_FROM"],
    error: "needs SMTP_HOST, SMTP_USER, SMTP_PASSWORD and SMTP_FROM to be set too",
    when: (payload) => payload.issues.every((issue) => String(issue.path?.[0]) !== "smtp"),
  })
  .refine(
    (env) => env.WATCHDOG_MODE !== "hosted" || !env.WATCHDOG_ENCRYPTION_KEY.equals(placeholderKey),
    {
      path: ["WATCHDOG_ENCRYPTION_KEY"],
      error: "must not be the placeholder from .env.example when WATCHDOG_MODE=hosted",
    },
  )
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
      ...(env.SMTP_ALERT_FROM !== undefined && { alertFrom: env.SMTP_ALERT_FROM }),
    },
    oauth: {
      google: env.google && oauth(env.google.GOOGLE_CLIENT_ID, env.google.GOOGLE_CLIENT_SECRET),
      github: env.github && oauth(env.github.GITHUB_CLIENT_ID, env.github.GITHUB_CLIENT_SECRET),
    },
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      // Hosted offers no user sessions (ADR 0014), so its values are dropped; loadConfig warns.
      api:
        env.WATCHDOG_MODE === "hosted" || env.telegramApi === undefined
          ? undefined
          : { id: env.telegramApi.TELEGRAM_API_ID, hash: env.telegramApi.TELEGRAM_API_HASH },
    },
    obscura: { cdpUrl: env.OBSCURA_CDP_URL, cdpToken: env.OBSCURA_CDP_TOKEN },
    chromium: env.chromium && { url: env.chromium.CHROMIUM_URL, token: env.chromium.CHROMIUM_TOKEN },
    egressAllowlist: env.EGRESS_ALLOWLIST,
    // A Workspace's rules cost the shared worker per Item, so hosted caps them; self-hosted has no
    // limit, and the values are absent rather than infinite (docs: Business model and licensing).
    ruleLimits:
      env.WATCHDOG_MODE === "hosted"
        ? {
            instructions: env.HOSTED_MAX_RULE_INSTRUCTIONS,
            rules: env.HOSTED_MAX_RULES,
            jsonPathFields: env.HOSTED_MAX_RULE_JSONPATH_FIELDS,
            jsonPathNodes: env.HOSTED_MAX_JSONPATH_NODES,
          }
        : undefined,
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
    if (result.data.mode === "hosted" && input.telegramApi !== undefined) {
      warn(
        "TELEGRAM_API_ID and TELEGRAM_API_HASH are ignored when WATCHDOG_MODE=hosted: hosted Watchdog offers no Telegram user sessions.",
      );
    }
    if (result.data.mode !== "hosted" && hostedLimitsSet(input)) {
      warn(
        "HOSTED_MAX_RULE_INSTRUCTIONS, HOSTED_MAX_RULES, HOSTED_MAX_RULE_JSONPATH_FIELDS and HOSTED_MAX_JSONPATH_NODES are ignored when WATCHDOG_MODE=self-hosted: a self-hosted Watchdog sets no rule limits.",
      );
    }
    if (result.data.encryptionKey.equals(placeholderKey)) {
      warn(
        "WATCHDOG_ENCRYPTION_KEY is the public placeholder from .env.example. Replace it before storing a secret: changing it later makes stored secrets unreadable.",
      );
    }
    return result.data;
  }

  // A grouped variable's path is [group, name]; the variable's own name is what people set.
  const lines = result.error.issues.map((issue) => `  ${String(issue.path.at(-1))}: ${issue.message}`);
  throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
}
