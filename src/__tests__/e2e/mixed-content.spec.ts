import { test, expect } from "@playwright/test";

/**
 * Mixed-content e2e: an https:// page pointing at an http:// OpenList is the
 * one failure mode that looks exactly like an outage (the browser kills the
 * request before it starts, fetch rejects with a TypeError) but has a totally
 * different fix. These specs pin that pshare diagnoses it as mixed content,
 * not "OpenList may be down".
 *
 * The bundle is served over TLS (self-signed cert, accepted via
 * ignoreHTTPSErrors) and pointed at the http:// OpenList. Playwright's
 * Chromium does not enforce the https→http block, so the spec aborts the
 * request at the route layer with the exact failure signature a real browser
 * produces (net::ERR_FAILED → fetch TypeError).
 */
const TLS_URL = process.env.PSHARE_E2E_TLS_URL ?? "";
const OL_URL = process.env.PSHARE_E2E_OL_URL ?? "";
const OL_KEY = process.env.PSHARE_E2E_OL_KEY ?? "";

test.skip(!TLS_URL || !OL_URL || !OL_KEY, "global setup did not export the TLS/OpenList connection");

test.describe("mixed content (https page, http backend)", () => {
  test("Test connection reports mixed content, not an outage", async ({ page }) => {
    // Reproduce what a real browser does to an http:// fetch from an https
    // page: abort the request with a generic network error (net::ERR_FAILED).
    await page.route(`${OL_URL}/**`, (route) => route.abort("failed"));

    await page.goto(TLS_URL);
    await page.getByLabel("OpenList URL").fill(OL_URL);
    await page.getByLabel("API key").fill(OL_KEY);
    await page.getByRole("button", { name: "Test connection" }).click();

    // The connection panel's verdict names the real cause...
    await expect(page.locator(".connection-panel .error")).toContainText(/mixed content/i);
    await expect(page.locator(".connection-panel .error")).toContainText(OL_URL);
    // ...and not the misleading outage message this used to show.
    await expect(page.locator(".connection-panel .error")).not.toContainText(/OpenList may be down/);
  });

  test("share view diagnoses mixed content too", async ({ page }) => {
    await page.route(`${OL_URL}/**`, (route) => route.abort("failed"));

    // Configure the browser with the http:// backend from the https page
    // (saving works — it's localStorage, no network needed).
    await page.goto(TLS_URL);
    await page.getByLabel("OpenList URL").fill(OL_URL);
    await page.getByLabel("API key").fill(OL_KEY);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const view = await page.context().newPage();
    await view.route(`${OL_URL}/**`, (route) => route.abort("failed"));
    await view.goto(`${TLS_URL}/s?id=abcdefghij&name=paste.txt`);
    await expect(view.locator(".card .muted")).toContainText(/mixed content/i);
    await view.close();
  });

  test("an https:// outage still shows the generic unreachable message", async ({ page }) => {
    // The special case must key off the scheme, not fire on every failure:
    // an https backend that is simply down gets the generic message.
    // (Port 1 on loopback: nothing listens → instant connection refused.)
    await page.goto(TLS_URL);
    await page.getByLabel("OpenList URL").fill("https://127.0.0.1:1");
    await page.getByLabel("API key").fill("some-key");
    await page.getByRole("button", { name: "Test connection" }).click();

    await expect(page.locator(".connection-panel .error")).toContainText(
      /could not reach https:\/\/127\.0\.0\.1:1/,
    );
    await expect(page.locator(".connection-panel .error")).not.toContainText(/mixed content/i);
  });
});
