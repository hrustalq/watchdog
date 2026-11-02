import { PostgreSqlContainer } from "@testcontainers/postgresql";

// Same major version as the Compose stack.
export const postgresImage = "postgres:18-alpine";

export interface TestPostgres {
  url: string;
  stop: () => Promise<void>;
}

/** Starts a throwaway Postgres container for an integration test. Needs Docker. */
export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer(postgresImage).start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
