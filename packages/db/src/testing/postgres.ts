import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { migrate as applyMigrations } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { inject } from "vitest";
import { closeDb, createDb } from "../client.ts";

// The Postgres in Compose (#8) must run the same major version.
export const postgresImage = "postgres:18-alpine";

export interface TestPostgres {
  url: string;
  stop: () => Promise<void>;
}

declare module "vitest" {
  export interface ProvidedContext {
    /** Answers with the URL of the run's shared Postgres server, started by `global-setup.ts`. */
    postgresBroker?: string;
  }
}

/**
 * Starts a Postgres container. Settings are for a throwaway server: every test file of a package
 * connects to the one server, and nothing on it needs to survive a crash.
 */
export async function startPostgresServer(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer(postgresImage)
    .withCommand(["postgres", "-c", "max_connections=1000", "-c", "fsync=off"])
    .start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}

/** The shared server's URL, asked of the global setup with node:http, which a test's stubbed fetch can't reach. */
function sharedServer(broker: string) {
  return new Promise<string>((resolve, reject) => {
    get(broker, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (body += chunk));
      response.on("end", () => {
        if (response.statusCode === 200) resolve(body);
        else reject(new Error(`The test Postgres server didn't start: ${body}`));
      });
    }).on("error", reject);
  });
}

/**
 * A throwaway database for an integration test. Needs Docker. On the package's shared server it's a new
 * database, created in well under a second, so test files don't each start a container, which starved a
 * machine running four packages at once (#436). Without the global setup it starts a server of its own.
 */
export async function startPostgres(): Promise<TestPostgres> {
  const broker = inject("postgresBroker");
  if (broker === undefined) return startPostgresServer();
  const serverUrl = await sharedServer(broker);
  const name = `test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = async (statement: string) => {
    const client = new Client({ connectionString: serverUrl });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };
  await admin(`create database ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    url: url.href,
    // Forced, as stopping a container was: a test that left a connection open still gets its database dropped.
    stop: () => admin(`drop database ${name} with (force)`),
  };
}

/**
 * Applies only the first `count` migrations, to build a database as it stood then. It reads a copy
 * of migrations/ whose journal stops there.
 */
export async function migrateFirst(databaseUrl: string, count: number): Promise<void> {
  const migrationsFolder = await mkdtemp(path.join(tmpdir(), "watchdog-migrations-"));
  const db = createDb(databaseUrl);
  try {
    await cp(path.join(import.meta.dirname, "../../migrations"), migrationsFolder, { recursive: true });
    const journalPath = path.join(migrationsFolder, "meta/_journal.json");
    const firstEntries = (key: string, value: unknown): unknown =>
      key === "entries" && Array.isArray(value) ? value.slice(0, count) : value;
    const journal = await readFile(journalPath, "utf8");
    await writeFile(journalPath, JSON.stringify(JSON.parse(journal, firstEntries)));
    await applyMigrations(db, { migrationsFolder });
  } finally {
    await closeDb(db);
    await rm(migrationsFolder, { recursive: true, force: true });
  }
}
