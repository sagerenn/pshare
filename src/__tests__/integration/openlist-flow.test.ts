/**
 * Integration test: boot a real openlist-ext binary and exercise the full
 * pshare flow against it — upload, list, get (signed download URL), download,
 * and remove. This proves our OpenListClient works against the real API, not
 * just a mock.
 *
 * Gated behind PSHARE_INTEGRATION=1 because it builds/boots the Go binary.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootOpenList, ensureBinary, type Harness } from "@/__tests__/harness/openlist-bin";
import { detectType } from "@/lib/share-utils";

let h: Harness;

beforeAll(async () => {
  if (process.env.PSHARE_INTEGRATION !== "1") {
    // eslint-disable-next-line no-console
    console.log("  (skipped: set PSHARE_INTEGRATION=1 to run)");
    return;
  }
  await ensureBinary();
  h = await bootOpenList();
}, 180_000);

afterAll(async () => {
  if (h) await h.teardown();
});

describe("OpenListClient against a real openlist-ext", () => {
  it("logs in and pings via /api/me", async () => {
    if (!h) return;
    // login already happened in the harness; token() should be cached.
    const tok = await h.client.token();
    expect(tok).toMatch(/^eyJ/);
  });

  it("uploads, lists, gets, downloads, and removes a text file", async () => {
    if (!h) return;
    const path = "/pshare/inttest/hello.txt";
    const content = "hello from integration test";
    await h.client.upload(path, content, Buffer.byteLength(content));

    const listed = await h.client.list("/pshare/inttest");
    expect(listed.content.some((e) => e.name === "hello.txt")).toBe(true);

    const info = await h.client.get(path);
    expect(info.raw_url).toContain("/p/pshare/inttest/hello.txt");
    expect(info.raw_url).toContain("sign=");

    // The raw_url is a public, no-auth download link.
    const dl = await fetch(info.raw_url);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(content);

    await h.client.remove("/pshare/inttest", ["hello.txt"]);
    const after = await h.client.list("/pshare/inttest");
    expect(after.content.some((e) => e.name === "hello.txt")).toBe(false);
  });

  it("uploads binary content (image bytes) and downloads it back intact", async () => {
    if (!h) return;
    // A tiny 1x1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
      "base64",
    );
    const path = "/pshare/inttest/pixel.png";
    await h.client.upload(path, png, png.length);
    expect(detectType("image/png", "pixel.png")).toBe("image");

    const info = await h.client.get(path);
    const dl = await fetch(info.raw_url);
    const body = Buffer.from(await dl.arrayBuffer());
    expect(body.equals(png)).toBe(true);

    await h.client.remove("/pshare/inttest", ["pixel.png"]);
  });

  it("rejects operations on a non-existent path", async () => {
    if (!h) return;
    await expect(h.client.get("/pshare/inttest/does-not-exist.txt")).rejects.toThrow();
  });
});
