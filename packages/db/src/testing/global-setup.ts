// Vitest's global setup for a package's integration tests: one Postgres server for the whole run,
// on which each test file's startPostgres() creates its own database (#436).
import type { TestProject } from "vitest/node";
import { startPostgresServer } from "./postgres.ts";

export default async function setup(project: TestProject) {
  // A unit run, such as the pre-push hook's, queues no integration file and so needs no Docker.
  const { testFiles } = await project.globTestFiles();
  if (!testFiles.some((file) => file.endsWith(".int.test.ts"))) return undefined;
  const server = await startPostgresServer();
  project.provide("postgresServerUrl", server.url);
  return server.stop;
}
