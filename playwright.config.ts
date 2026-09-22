import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e config. The e2e tests boot a real openlist-ext binary and
 * the real Next.js pshare server in a global setup, then drive a browser
 * against them. Run with `npm run test:e2e` (after `npm run test:e2e:install`
 * once to fetch chromium).
 */
export default defineConfig({
  testDir: "./src/__tests__/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.PSHARE_E2E_URL || "http://127.0.0.1:3137",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Global setup boots OpenList + the Next app and tears them down after.
  globalSetup: "./src/__tests__/e2e/global-setup.ts",
  globalTeardown: "./src/__tests__/e2e/global-teardown.ts",
});
