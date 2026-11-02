import { existsSync } from "node:fs";
import { defineConfig } from "drizzle-kit";

// Developers keep DATABASE_URL in the repo's .env, as web and worker do. Variables already set in
// the environment win.
if (existsSync("../../.env")) process.loadEnvFile("../../.env");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // pg-boss owns the pgboss schema (ADR 0004). Only public is Drizzle's to diff, push or drop.
  schemaFilter: ["public"],
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
