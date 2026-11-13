import { defineConfig } from "vitest/config";

// Only catches a hang: a loaded CI runner can take several times as long as a quiet one.
// The `@/` alias mirrors tsconfig's paths, so a component test can load a component that imports it.
export default defineConfig({
  resolve: { alias: [{ find: /^@\//, replacement: `${import.meta.dirname}/src/` }] },
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
