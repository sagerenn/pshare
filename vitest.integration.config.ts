import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Vitest config for integration tests. These boot a real openlist-ext binary
 * (and, for the API test, a real Next.js server), so they're slower and gated
 * behind PSHARE_INTEGRATION=1. Kept separate from the default (unit) config
 * so `npm test` stays fast and hermetic.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/__tests__/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // Don't run the unit setup (which resets env per test); integration tests
    // manage their own env.
    setupFiles: [],
  },
});
