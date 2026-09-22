import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    // Unit tests run by default. Integration tests boot a real OpenList
    // binary and are gated behind the PSHARE_INTEGRATION env var so a plain
    // `vitest run` stays fast and hermetic.
    include: ["src/__tests__/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
