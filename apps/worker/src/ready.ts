import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Exists while the worker has applied the migrations and pg-boss is running. The Compose
 * healthcheck tests for it (`/tmp/watchdog-worker-ready` in the container), and web starts once
 * the worker is healthy, so web never serves requests against an unmigrated database.
 */
export const readyFile = path.join(tmpdir(), "watchdog-worker-ready");
