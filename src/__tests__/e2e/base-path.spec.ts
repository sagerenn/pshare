import { test, expect } from "@playwright/test";

/**
 * Sub-path deployment e2e (the GitHub Pages shape). global-setup builds a
 * bundle with NEXT_PUBLIC_BASE_PATH=/pshare and serves it under that prefix
 * (port 3139), so every URL the app generates — /_next assets, share links,
 * the manifest link, service-worker registration — must carry the prefix to
 * resolve. The harness 404s any request that arrives outside the prefix,
 * which is exactly what https://<owner>.github.io would do.
 */
const BASEPATH_URL = process.env.PSHARE_E2E_BASEPATH_URL ?? "http://127.0.0.1:3139/pshare";

test.describe("base-path bundle (GitHub Pages shape)", () => {
  test("loads the app shell with prefixed assets and manifest", async ({ page }) => {
    await page.goto(BASEPATH_URL);

    await expect(page.locator("h1")).toHaveText("pshare");
    // Next prefixes /_next assets with the base path; an unprefixed one
    // would 404 and the page would render unstyled / unhydrated.
    const css = page.locator('link[rel="stylesheet"]');
    await expect(css).toHaveCount(1);
    expect(await css.getAttribute("href")).toContain("/pshare/_next/");

    // The manifest link is patched post-build by scripts/apply-base-path.js.
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    expect(manifestHref).toBe("/pshare/manifest.webmanifest");
    const res = await page.request.get(`${BASEPATH_URL}/manifest.webmanifest`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/manifest+json");
    const manifest = (await res.json()) as { start_url?: string; scope?: string };
    expect(manifest.start_url).toBe("/pshare/");
    expect(manifest.scope).toBe("/pshare/");
  });

  test("creates a share whose link carries the base path, and it opens", async ({ page }) => {
    await page.goto(BASEPATH_URL);
    await page.locator("textarea").fill("shared from a sub-path deployment");
    await page.getByRole("button", { name: "Create share" }).click();

    const urlInput = page.locator(".result-url input");
    await expect(urlInput).toBeVisible();
    const url = await urlInput.inputValue();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pshare\/s\?id=[a-z2-7]{10}&name=paste\.txt$/);

    const view = await page.context().newPage();
    await view.goto(url);
    await expect(view.locator(".text-view")).toHaveText("shared from a sub-path deployment");
    await view.close();
  });

  test("registers the service worker under the base-path scope", async ({ page }) => {
    await page.goto(BASEPATH_URL);
    const scope = await page.evaluate(() =>
      navigator.serviceWorker.ready.then((r) => r.scope),
    );
    expect(scope).toMatch(/\/pshare\/$/);
  });
});
