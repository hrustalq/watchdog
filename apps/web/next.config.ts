import { existsSync } from "node:fs";
import type { NextConfig } from "next";

// The repo-root .env serves web and worker alike. Next.js reads only apps/web/.env* itself.
// Variables already in the environment win, as with Next's own .env loading.
const rootEnv = new URL("../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  /* config options here */
  // The root AGENTS.md carries the Next.js docs pointer; don't write a second one here.
  agentRules: false,
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
