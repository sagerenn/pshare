/**
 * Integration test: boot a real openlist-ext binary (with a provisioned
 * non-admin user + scoped API key) and exercise the pshare browser client
 * against it — upload (with per-file X-Ttl), get (signed download URL),
 * download, and remove. Also verifies the scoped key cannot list (CanList
 * is disabled) and that a per-file TTL override is recorded.
 *
 * Gated behind PSHARE_INTEGRATION=1 because it builds/boots the Go binary.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootOpenList, ensureBinary, type Harness } from "@/__tests__/harness/openlist-bin";
import { detectType } from "@/lib/share-utils";
import { OpenListError } from "@/lib/openlist-client";

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

describe("OpenListClient (API key) against a real openlist-ext", () => {
  it("uploads, gets, downloads, and removes a text file", async () => {
    if (!h) return;
    const path = "/pshare/inttest/hello.txt";
    const content = "hello from integration test";
    await h.client.upload(path, content, Buffer.byteLength(content));

    const info = await h.client.get(path);
    expect(info.raw_url).toContain("/p/pshare/inttest/hello.txt");
    expect(info.raw_url).toContain("sign=");

    // The raw_url is a public, no-auth download link.
    const dl = await fetch(info.raw_url);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(content);

    await h.client.remove("/pshare/inttest", ["hello.txt"]);
    await expect(h.client.get(path)).rejects.toThrow();
  });

  it("uploads binary content (image bytes) and downloads it back intact", async () => {
    if (!h) return;
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

  it("sends a per-file X-Ttl override that is recorded by OpenList", async () => {
    if (!h) return;
    // Upload with a 2-second per-file TTL.
    const path = "/pshare/inttest/shortlived.txt";
    await h.client.upload(path, "gone soon", 9, 2);

    // File exists immediately.
    const info = await h.client.get(path);
    expect(info.raw_url).toBeTruthy();

    // After the per-file TTL elapses, OpenList's reaper should have removed
    // it. Poll briefly rather than sleep a fixed long time.
    let gone = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        await h.client.get(path);
      } catch (e) {
        if (e instanceof OpenListError && (e.code === 404 || /not found/i.test(e.message))) {
          gone = true;
          break;
        }
      }
    }
    expect(gone).toBe(true);
  });

  it("rejects listing for the scoped (no-list) key", async () => {
    if (!h) return;
    // The provisioned user has CanList=false, so /api/fs/list must be denied.
    const r = await fetch(`${h.baseUrl}/api/fs/list`, {
      method: "POST",
      headers: { Authorization: `Bearer ${h.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/pshare" }),
    });
    const j = (await r.json().catch(() => ({}))) as { code?: number };
    expect(j.code).not.toBe(200);
  });

  it("rejects operations on a non-existent path", async () => {
    if (!h) return;
    await expect(h.client.get("/pshare/inttest/does-not-exist.txt")).rejects.toThrow();
  });
});
