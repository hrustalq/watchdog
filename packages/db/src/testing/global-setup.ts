// Vitest's global setup for a package's tests: one Postgres server for the whole run, on which each test
// file's startPostgres() creates its own database (#436). The server starts on the first file that asks,
// so a run with no database test, such as the pre-push hook's unit run, needs no Docker.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestProject } from "vitest/node";
import { startPostgresServer, type TestPostgres } from "./postgres.ts";

export default async function setup(project: TestProject) {
  let server: Promise<TestPostgres> | undefined;
  const broker = createServer((_request, response) => {
    server ??= startPostgresServer();
    server.then(
      ({ url }) => response.end(url),
      (error: unknown) => {
        response.statusCode = 500;
        response.end(String(error));
      },
    );
  });
  await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
  project.provide("postgresBroker", `http://127.0.0.1:${String((broker.address() as AddressInfo).port)}`);
  return async () => {
    broker.close();
    await server?.then(({ stop }) => stop(), () => undefined);
  };
}
