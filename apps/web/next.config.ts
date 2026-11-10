import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// The repo-root .env serves web and worker alike. Next.js reads only apps/web/.env* itself.
// Variables already in the environment win, as with Next's own .env loading.
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  /* config options here */
  // The root AGENTS.md carries the Next.js docs pointer; don't write a second one here.
  agentRules: false,
  // An inbox request's path holds its Inbox token, so the dev server mustn't log it. Production
  // doesn't log requests.
  logging: { incomingRequests: { ignore: [/^\/api\/inbox\//] } },
  // The Docker image runs .next/standalone/apps/web/server.js. Tracing from the repo root takes
  // in the workspace packages web imports, which live outside apps/web.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  cacheComponents: true,
  partialPrefetching: true,
  reactCompiler: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
