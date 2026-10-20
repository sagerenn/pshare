import { test, expect } from "@playwright/test";

/**
 * Sub-path deployment e2e: OpenList served behind a prefix-stripping reverse
 * proxy (Caddy `handle_path /openlist/*`, nginx `proxy_pass .../` with the
 * trailing slash, httpd `ProxyPass /openlist/ .../`) — the deployed shape
 * "https://site/openlist/ is OpenList".
 *
 * The API side works by simple path concatenation, but OpenList mints the
 * signed download URL (raw_url) from its OWN origin — the backend's
 * 127.0.0.1:port — so without rebasing, every download, image, and media
 * element points at an address the visitor cannot reach. These specs drive
 * the whole journey through the proxy and verify the browser really renders
 * content from the rebased URLs.
 */
const UNCONFIGURED_URL = process.env.PSHARE_E2E_UNCONFIGURED_URL ?? "http://127.0.0.1:3138";
const OL_PROXY_URL = process.env.PSHARE_E2E_OL_PROXY_URL ?? "";
const OL_KEY = process.env.PSHARE_E2E_OL_KEY ?? "";

test.skip(!OL_PROXY_URL || !OL_KEY, "global setup did not export the proxied OpenList connection");

test.describe("OpenList behind a sub-path reverse proxy", () => {
  test("shares and previews end to end through the /openlist prefix", async ({ page }) => {
    // Configure from the page with the public proxied URL — the visitor's
    // journey on a sub-path deployment (no rebuild needed).
    await page.goto(UNCONFIGURED_URL);
    await page.getByLabel("OpenList URL").fill(OL_PROXY_URL);
    await page.getByLabel("API key").fill(OL_KEY);
    await page.getByRole("button", { name: "Test connection" }).click();
    await expect(page.locator(".notice-ok")).toContainText(/Connected/);
    await expect(page.locator(".notice-ok")).toContainText(OL_PROXY_URL);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // Share a markdown file through the prefixed API.
    const md = "# Subpath deploy\n\n**works** through /openlist\n";
    await page.getByRole("button", { name: "File" }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "notes.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(md, "utf8"),
    });
    await page.getByRole("button", { name: "Create share" }).click();
    const mdUrl = await page.locator(".result-url input").inputValue();
    const mdView = await page.context().newPage();
    await mdView.goto(mdUrl);
    await expect(mdView.locator(".md-view h1")).toHaveText("Subpath deploy");
    await expect(mdView.locator(".md-view strong")).toHaveText("works");
    // The text content itself is fetched from the rebased signed URL.
    await mdView.close();

    // Share an image: the <img> must load real bytes from a URL that carries
    // the /openlist prefix — the rebased raw_url, not OpenList's own origin.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR42mP8z8BQzwAEYAFn0lpeFQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.getByRole("button", { name: "File" }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: "dot.png",
      mimeType: "image/png",
      buffer: png,
    });
    await page.getByRole("button", { name: "Create share" }).click();
    const imgUrl = await page.locator(".result-url input").inputValue();
    const imgView = await page.context().newPage();
    await imgView.goto(imgUrl);
    const img = imgView.locator("img.media");
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute("src", new RegExp(`${OL_PROXY_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(p|d)/`));
    // It really decodes through the prefixed proxy.
    const natural = await img.evaluate((i) => (i as HTMLImageElement).naturalWidth);
    expect(natural).toBeGreaterThan(0);

    // And the Download link points at the prefixed URL too.
    const href = await imgView.locator("a.download-btn").getAttribute("href");
    expect(href).toContain("/openlist/");
    await imgView.close();
  });
});
