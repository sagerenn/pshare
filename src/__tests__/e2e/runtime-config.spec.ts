import { test, expect } from "@playwright/test";

/**
 * Runtime configuration e2e: pshare can be pointed at an OpenList backend
 * from the page itself, with the URL + API key saved in the browser — no
 * rebuild needed. These specs run against two bundles booted by global
 * setup:
 *
 *  - the unconfigured bundle (port 3138): built with no build-time
 *    connection, so configuring on the page is the only way in — the same
 *    situation as deploying the prebuilt image without build args.
 *  - the configured bundle (port 3137): the connection is baked in, and a
 *    saved runtime connection must override it.
 */
const UNCONFIGURED_URL = process.env.PSHARE_E2E_UNCONFIGURED_URL ?? "http://127.0.0.1:3138";
const OL_URL = process.env.PSHARE_E2E_OL_URL ?? "";
const OL_KEY = process.env.PSHARE_E2E_OL_KEY ?? "";

test.skip(!OL_URL || !OL_KEY, "global setup did not export the OpenList connection");

test.describe("runtime configuration (unconfigured bundle)", () => {
  test("prompts for setup and disables sharing until configured", async ({ page }) => {
    await page.goto(UNCONFIGURED_URL);

    // The setup banner shows and the connection panel is already open with
    // empty fields.
    await expect(page.getByText("pshare is not configured.")).toBeVisible();
    await expect(page.getByLabel("OpenList URL")).toBeVisible();
    await expect(page.getByLabel("API key")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create share" })).toBeDisabled();
  });

  test("configures the OpenList URL and API key on the page, then shares", async ({ page }) => {
    await page.goto(UNCONFIGURED_URL);

    // Enter the real backend the harness provisioned and verify it live.
    await page.getByLabel("OpenList URL").fill(OL_URL);
    await page.getByLabel("API key").fill(OL_KEY);
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.locator(".notice-ok")).toContainText(/Connected/);

    // Save — the settings apply immediately, no reload needed.
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".notice-ok")).toContainText(/Saved/);
    await expect(page.getByRole("button", { name: "Create share" })).toBeEnabled();

    // The whole share journey now works with the runtime connection.
    await page.locator("textarea").fill("configured at runtime");
    await page.getByRole("button", { name: "Create share" }).click();
    const url = await page.locator(".result-url input").inputValue();
    expect(url).toMatch(/\/s\?id=[a-z2-7]{10}&name=paste\.txt$/);

    const view = await page.context().newPage();
    await view.goto(url);
    await expect(view.locator(".text-view")).toHaveText("configured at runtime");
    await view.close();
  });

  test("saved settings survive a reload", async ({ page }) => {
    await page.goto(UNCONFIGURED_URL);
    await page.getByLabel("OpenList URL").fill(OL_URL);
    await page.getByLabel("API key").fill(OL_KEY);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Create share" })).toBeEnabled();

    await page.reload();
    // No setup banner after reload: the saved connection is picked up.
    await expect(page.getByText("pshare is not configured.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Create share" })).toBeEnabled();
    await page.locator("textarea").fill("persisted settings");
    await page.getByRole("button", { name: "Create share" }).click();
    await expect(page.locator(".result-url input")).toBeVisible();
  });

  test("clearing saved settings reverts to the unconfigured state", async ({ page }) => {
    await page.goto(UNCONFIGURED_URL);
    await page.getByLabel("OpenList URL").fill(OL_URL);
    await page.getByLabel("API key").fill(OL_KEY);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Create share" })).toBeEnabled();

    await page.getByRole("button", { name: "Clear saved settings" }).click();
    await expect(page.getByText("pshare is not configured.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create share" })).toBeDisabled();
  });
});

test.describe("runtime override (configured bundle)", () => {
  test("a saved connection overrides the baked-in key; clearing restores it", async ({ page }) => {
    await page.goto("/");

    // The bundle is configured, so the panel starts collapsed.
    await page.getByRole("button", { name: /^OpenList connection/ }).click();
    await expect(page.getByLabel("OpenList URL")).toBeVisible();

    // Save a connection with an invalid key — it must win over the good
    // baked-in one, proving the runtime settings are actually used. (A bad
    // key surfaces as a network error here: OpenList's auth middleware
    // aborts before its CORS middleware runs, so the browser hides the 401.)
    await page.getByLabel("OpenList URL").fill(OL_URL);
    await page.getByLabel("API key").fill("definitely-not-a-valid-key");
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await page.locator("textarea").fill("should fail");
    await page.getByRole("button", { name: "Create share" }).click();
    await expect(page.locator(".card > .error")).toContainText(/could not reach OpenList/i);

    // Clearing the saved settings falls back to the baked-in connection.
    await page.getByRole("button", { name: "Clear saved settings" }).click();
    await expect(page.getByRole("button", { name: "Create share" })).toBeEnabled();
    await page.getByRole("button", { name: "Create share" }).click();
    await expect(page.locator(".result-url input")).toBeVisible();
  });
});
