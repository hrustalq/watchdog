import { PostgreSqlContainer } from "@testcontainers/postgresql";

// The Postgres in Compose (#8) must run the same major version.
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
