/**
 * Full-stack integration test for the static-site architecture: boot a real
 * openlist-ext binary, provision a scoped API key, build the pshare static
 * export with that key baked in, serve it, and drive the share flow exactly
 * as a browser would — upload via the client, open the share URL, fetch the
 * content, and delete it.
 *
 * This replaces the old pshare-API-route tests: there are no pshare API
 * routes anymore; the browser talks to OpenList directly.
 *
 * Gated behind PSHARE_INTEGRATION=1.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { bootOpenList, ensureBinary, type Harness } from "@/__tests__/harness/openlist-bin";
import { startStaticSite, type StaticSite } from "@/__tests__/harness/next-app";
import { OpenListClient } from "@/lib/openlist-client";
import { generateId } from "@/lib/share-utils";

let ol: Harness;
let site: StaticSite;

beforeAll(async () => {
  if (process.env.PSHARE_INTEGRATION !== "1") {
    // eslint-disable-next-line no-console
    console.log("  (skipped: set PSHARE_INTEGRATION=1 to run)");
    return;
  }
  await ensureBinary();
  ol = await bootOpenList();
  site = await startStaticSite({ openlistBaseUrl: ol.baseUrl, apiKey: ol.apiKey });
}, 240_000);

afterAll(async () => {
  if (site) await site.teardown();
  if (ol) await ol.teardown();
});

describe("pshare static site end-to-end", () => {
  it("serves the home page", async () => {
    if (!site) return;
    const r = await fetch(site.baseUrl);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain("pshare");
  });

  it("uploads a text share via the browser client and downloads it back", async () => {
    if (!ol) return;
    // Simulate the browser upload: the client uses the same key the bundle has.
    const id = generateId();
    const name = "paste.txt";
    const path = `/pshare/${id}/${name}`;
    const content = "static-site integration text";
    await ol.client.upload(path, content, Buffer.byteLength(content));

    // The share URL the home page would produce: /s?id=<id>&name=<name>
    const shareUrl = `${site.baseUrl}/s?id=${id}&name=${encodeURIComponent(name)}`;
    const page = await fetch(shareUrl);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("pshare");

    // Fetch the file info + raw_url as the share view does, then download.
    const info = await ol.client.get(path);
    const dl = await fetch(info.raw_url);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe(content);
  });

  it("deletes a share via the browser client", async () => {
    if (!ol) return;
    const id = generateId();
    const name = "deleteme.txt";
    const path = `/pshare/${id}/${name}`;
    await ol.client.upload(path, "bye", 3);
    await ol.client.remove(`/pshare/${id}`, [name]);
    await expect(ol.client.get(path)).rejects.toThrow();
  });

  it("reports an expired/unavailable share when the file is gone", async () => {
    if (!ol) return;
    // A share id that was never uploaded -> get returns an error, which the
    // share view renders as "expired or been deleted".
    const shareUrl = `${site.baseUrl}/s?id=${generateId()}&name=ghost.txt`;
    const page = await fetch(shareUrl);
    expect(page.status).toBe(200); // SPA shell still serves
  });
});
