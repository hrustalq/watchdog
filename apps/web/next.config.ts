import type { NextConfig } from "next";

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
