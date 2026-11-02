import { loadConfig } from "@watchdog/core";
import { createDb } from "@watchdog/db";

// The web app's one Drizzle client. The pg pool connects on the first query, not on import.
export const db = createDb(loadConfig().databaseUrl);
