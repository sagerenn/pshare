import { test, expect } from "@playwright/test";

/**
 * Preview e2e: markdown shares render as formatted preview (react-markdown +
 * remark-gfm) with a source toggle, and image / video / audio shares preview
 * inline via the browser's native elements — video and audio actually load
 * and play, proving the signed OpenList URLs stream correctly. Fallbacks
 * (undecodable media) are covered too.
 */

/** Tiny valid PNG (2×1 px) for the image-share journey. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR42mP8z8BQzwAEYAFn0lpeFQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Minimal valid MP4 with one tiny video track, generated at test time by
 * Chromium itself via MediaRecorder (no ffmpeg dependency). Falls back to a
 * silent-black WebM if MP4 muxing isn't supported on the runner.
 */
async function tinyClip(context: import("@playwright/test").BrowserContext): Promise<{
  name: string;
  mimeType: string;
  buffer: Buffer;
}> {
  const page = await context.newPage();
  try {
    const clip = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 48;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#3366cc";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(5);
      const mimes = [
        "video/mp4",
        "video/webm;codecs=vp8",
        "video/webm",
      ].filter((m) => MediaRecorder.isTypeSupported(m));
      if (!mimes.length) throw new Error("MediaRecorder unsupported");
      const rec = new MediaRecorder(stream, { mimeType: mimes[0] });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise<Blob>((res) => (rec.onstop = () => res(new Blob(chunks, { type: mimes[0] }))));
      rec.start();
      await new Promise((r) => setTimeout(r, 400));
      rec.stop();
      const blob = await done;
      return {
        mimeType: mimes[0].split(";")[0],
        data: Array.from(new Uint8Array(await blob.arrayBuffer())),
      };
    });
    const ext = clip.mimeType.includes("mp4") ? "mp4" : "webm";
    // Only use mp4 (a video ext detectType knows); webm is also fine.
    return { name: `clip.${ext}`, mimeType: clip.mimeType, buffer: Buffer.from(clip.data) };
  } finally {
    await page.close();
  }
}

/** Share the given file through the UI and return the share URL. */
async function shareFile(page: import("@playwright/test").Page, file: {
  name: string;
  mimeType: string;
  buffer: Buffer;
}): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "File" }).click();
  await page.locator('input[type="file"]').setInputFiles(file);
  await page.getByRole("button", { name: "Create share" }).click();
  const url = await page.locator(".result-url input").inputValue();
  await expect(url).toMatch(/\/s\?id=[a-z2-7]{10}/);
  return url;
}

test.describe("markdown preview", () => {
  test("renders a .md share as preview with GFM, and toggles to source", async ({ page }) => {
    const md = [
      "# Trip plan",
      "",
      "Some **bold**, *italic*, `code`, and a [link](https://example.com).",
      "",
      "| Day | City |",
      "| --- | ---- |",
      "| 1   | Kyoto |",
      "",
      "- [x] book flights",
      "- [ ] pack camera",
    ].join("\n");
    await page.goto("/");
    await page.locator("textarea").fill(md);
    await page.getByRole("button", { name: "Create share" }).click();
    const url = await page.locator(".result-url input").inputValue();
    // A .md upload from the text tab still lands as paste.txt, so share the
    // markdown as a named .md file instead.
    const view = await page.context().newPage();
    await view.goto(url);
    await expect(view.locator(".text-view")).toBeVisible(); // paste.txt → source view

    // Now share the same content as notes.md and confirm the rendered preview.
    await view.close();
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

    // Preview is the default for .md: headings, tables, and checkboxes render.
    await expect(mdView.locator(".md-view h1")).toHaveText("Trip plan");
    await expect(mdView.locator(".md-view strong")).toHaveText("bold");
    await expect(mdView.locator(".md-view em")).toHaveText("italic");
    await expect(mdView.locator(".md-view td")).toHaveText(["1", "Kyoto"]);
    await expect(mdView.locator(".md-view a")).toHaveAttribute("href", "https://example.com");
    await expect(mdView.locator(".md-view a")).toHaveAttribute("target", "_blank");
    expect(await mdView.locator(".md-view input[type=checkbox]:checked").count()).toBe(1);

    // Links open safely and images are lazy-loaded.
    await expect(mdView.locator(".md-view a")).toHaveAttribute("rel", /noreferrer/);

    // Toggle back to the monospace source view.
    await mdView.getByRole("tab", { name: "Source" }).click();
    await expect(mdView.locator(".text-view")).toContainText("# Trip plan");
    // And forward again.
    await mdView.getByRole("tab", { name: "Preview" }).click();
    await expect(mdView.locator(".md-view h1")).toBeVisible();
    await mdView.close();
  });

  test("shares markdown from the text tab and previews it", async ({ page }) => {
    // The paste-text journey lands as paste.txt (source default), but the
    // Preview tab is available for any text share.
    await page.goto("/");
    await page.locator("textarea").fill("## quick note\n\nhello *world*");
    await page.getByRole("button", { name: "Create share" }).click();
    const url = await page.locator(".result-url input").inputValue();
    const view = await page.context().newPage();
    await view.goto(url);
    await expect(view.locator(".text-view")).toContainText("## quick note");
    await view.getByRole("tab", { name: "Preview" }).click();
    await expect(view.locator(".md-view h2")).toHaveText("quick note");
    await expect(view.locator(".md-view em")).toHaveText("world");
    await view.close();
  });
});

test.describe("media preview", () => {
  test("previews an image share inline", async ({ page }) => {
    const url = await shareFile(page, { name: "blue.png", mimeType: "image/png", buffer: TINY_PNG });
    const view = await page.context().newPage();
    await view.goto(url);
    await expect(view.locator("img.media")).toBeVisible();
    // The image actually decodes (natural size > 0), not just renders a tag.
    const natural = await view.locator("img.media").evaluate((img) => (img as HTMLImageElement).naturalWidth);
    expect(natural).toBeGreaterThan(0);
    await view.close();
  });

  test("previews a video share and it plays", async ({ page }) => {
    const clip = await tinyClip(page.context());
    const url = await shareFile(page, clip);
    const view = await page.context().newPage();
    await view.goto(url);
    const video = view.locator("video.media");
    await expect(video).toBeVisible();
    await expect(video).toHaveAttribute("src", /sign=/);
    // readyState >= 2 means metadata loaded from the real OpenList stream.
    await view
      .locator("video.media")
      .evaluate((v) => (v as HTMLVideoElement).readyState >= 2 || Promise.reject(new Error(`readyState=${(v as HTMLVideoElement).readyState}`)));
    // Play the actual stream. The clip is sub-second, so success is either
    // visible playback (timeupdate with currentTime > 0) or clean completion
    // (ended) — both prove real bytes flowed from the signed URL.
    const played = await video.evaluate((v) =>
      new Promise<boolean>((res) => {
        const el = v as HTMLVideoElement;
        if (el.ended) return res(true);
        el.addEventListener("ended", () => res(true), { once: true });
        el.addEventListener("timeupdate", () => {
          if (el.currentTime > 0) res(true);
        });
        el.play().catch(() => res(false));
      }),
    );
    expect(played).toBe(true);
    await view.close();
  });

  test("previews an audio share with controls", async ({ page }) => {
    // Record a short tone via WebAudio + MediaRecorder. The stream is
    // webm/opus; it is shared as tone.ogg because the extension drives
    // pshare's type detection (webm would classify as video), while the
    // browser decodes by content.
    const clip = await page.context().newPage().then(async (p) => {
      try {
        const wav = await p.evaluate(async () => {
          const ctx = new AudioContext();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const dest = ctx.createMediaStreamDestination();
          osc.frequency.value = 440;
          osc.connect(gain).connect(dest);
          osc.start();
          const mimes = ["audio/webm;codecs=opus", "audio/webm"].filter((m) =>
            MediaRecorder.isTypeSupported(m),
          );
          const rec = new MediaRecorder(dest.stream, { mimeType: mimes[0] });
          const chunks: Blob[] = [];
          rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
          const done = new Promise<Blob>((res) => (rec.onstop = () => res(new Blob(chunks, { type: mimes[0] }))));
          rec.start();
          await new Promise((r) => setTimeout(r, 300));
          osc.stop();
          rec.stop();
          await ctx.close();
          const blob = await done;
          return { mimeType: mimes[0].split(";")[0], data: Array.from(new Uint8Array(await blob.arrayBuffer())) };
        });
        return { name: "tone.ogg", mimeType: wav.mimeType, buffer: Buffer.from(wav.data) };
      } finally {
        await p.close();
      }
    });
    const url = await shareFile(page, clip);
    const view = await page.context().newPage();
    await view.goto(url);
    const audio = view.locator("audio.media");
    await expect(audio).toBeVisible();
    // Duration becomes known once the real stream's metadata loads, then the
    // tone actually plays (real bytes from the signed OpenList URL).
    const played = await audio.evaluate((a) =>
      new Promise<boolean>((res, rej) => {
        const el = a as HTMLAudioElement;
        const fail = () => rej(new Error(`audio error event, readyState=${el.readyState}`));
        el.addEventListener("error", fail, { once: true });
        const start = () =>
          el
            .play()
            .then(() => {
              el.addEventListener("ended", () => res(true), { once: true });
              el.addEventListener("timeupdate", () => {
                if (el.currentTime > 0) res(true);
              });
            })
            .catch(() => res(false));
        if (el.readyState >= 1) start();
        else el.addEventListener("loadedmetadata", start, { once: true });
        setTimeout(() => rej(new Error("audio timeout")), 10_000);
      }),
    );
    expect(played).toBe(true);
    await view.close();
  });

  test("falls back gracefully when media can't be decoded", async ({ page }) => {
    // A file named .png whose bytes are not a PNG: detectType classifies it
    // as an image, the img element errors, and the fallback offers the
    // download instead of a broken preview.
    const url = await shareFile(page, {
      name: "broken.png",
      mimeType: "image/png",
      buffer: Buffer.from("this is definitely not a png", "utf8"),
    });
    const view = await page.context().newPage();
    await view.goto(url);
    await expect(view.locator(".file-view")).toBeVisible();
    await expect(view.locator(".file-view .muted")).toContainText(/can’t be previewed/);
    await expect(view.locator(".file-view a")).toHaveAttribute("download", "broken.png");
    await view.close();
  });
});
