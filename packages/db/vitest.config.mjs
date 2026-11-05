import { defineConfig } from "vitest/config";

// Only catches a hang: a loaded CI runner can take several times as long as a quiet one.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
