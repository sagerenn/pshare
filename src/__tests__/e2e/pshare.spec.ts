import { test, expect } from "@playwright/test";

/**
 * End-to-end browser tests for pshare. These run against the real static
 * export (built with a provisioned OpenList API key) backed by a real
 * openlist-ext binary (booted in global-setup). They cover the user-facing
 * journeys: sharing text, sharing a file/image, opening a share link, and
 * seeing an unavailable share.
 */

test.describe("pshare home page", () => {
  test("renders the heading and tabs", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("pshare");
    await expect(page.getByText("Share temporary text", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Text" })).toBeVisible();
    await expect(page.getByRole("button", { name: "File" })).toBeVisible();
  });

  test("creates a text share and shows a share link", async ({ page }) => {
    await page.goto("/");
    await page.locator("textarea").fill("e2e hello text");
    await page.getByRole("button", { name: "Create share" }).click();

    // A result box with a copyable URL appears.
    const urlInput = page.locator(".result-url input");
    await expect(urlInput).toBeVisible();
    const url = await urlInput.inputValue();
    expect(url).toMatch(/\/s\?id=[a-z2-7]{10}&name=paste\.txt$/);

    // The result meta mentions the type.
    await expect(page.locator(".result-meta")).toContainText("text");
  });
});

test.describe("opening a share link", () => {
  test("shows the text content on the share page", async ({ page }) => {
    await page.goto("/");
    await page.locator("textarea").fill("viewable text content");
    await page.getByRole("button", { name: "Create share" }).click();
    const url = await page.locator(".result-url input").inputValue();

    const view = await page.context().newPage();
    await view.goto(url);
    await expect(view.locator("h1")).toHaveText("pshare");
    await expect(view.locator(".text-view")).toHaveText("viewable text content");
    await view.close();
  });

  test("renders an image share inline", async ({ page }) => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR42mP8z8BQzwAEYAFn0lpeFQAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.goto("/");
    await page.getByRole("button", { name: "File" }).click();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "red.png",
      mimeType: "image/png",
      buffer: png,
    });
    await expect(page.locator(".file-meta")).toContainText("image/png");
    await page.getByRole("button", { name: "Create share" }).click();

    const url = await page.locator(".result-url input").inputValue();
    const view = await page.context().newPage();
    await view.goto(url);
    await expect(view.locator("img.media")).toBeVisible();
    await expect(view.locator("img.media")).toHaveAttribute("src", /sign=/);
    await view.close();
  });

  test("shows an unavailable message for a non-existent share", async ({ page }) => {
    // A share id that was never uploaded; the share view fetches the file and
    // renders the "expired or been deleted" message.
    await page.goto("/s?id=doesnotexist&name=ghost.txt");
    await expect(page.locator("h2")).toHaveText("Unavailable");
    await expect(page.locator(".muted")).toContainText(/expired|deleted|not found/i);
  });

  test("creates a share with a per-file TTL and views it", async ({ page }) => {
    await page.goto("/");
    await page.locator("textarea").fill("short lived");
    // Pick the 10 minutes preset (per-file X-Ttl override).
    await page.locator("select").first().selectOption("600");
    await page.getByRole("button", { name: "Create share" }).click();
    const url = await page.locator(".result-url input").inputValue();
    const view = await page.context().newPage();
    await view.goto(url);
    await expect(view.locator(".text-view")).toHaveText("short lived");
    await view.close();
  });
});

test.describe("download button", () => {
  test("offers a download link on the share page", async ({ page }) => {
    await page.goto("/");
    await page.locator("textarea").fill("downloadable");
    await page.getByRole("button", { name: "Create share" }).click();
    const url = await page.locator(".result-url input").inputValue();
    const view = await page.context().newPage();
    await view.goto(url);
    const dl = view.locator("a.download-btn");
    await expect(dl).toBeVisible();
    await expect(dl).toHaveAttribute("href", /sign=/);
    await view.close();
  });
});

test.describe("delete button", () => {
  test("deletes a share from the share page", async ({ page }) => {
    await page.goto("/");
    await page.locator("textarea").fill("delete me please");
    await page.getByRole("button", { name: "Create share" }).click();
    const url = await page.locator(".result-url input").inputValue();

    const view = await page.context().newPage();
    await view.goto(url);
    await view.getByRole("button", { name: "Delete" }).click();
    await expect(view.getByText("Deleted.")).toBeVisible();
    await view.close();
  });
});
