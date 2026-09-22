/**
 * Full-stack integration test: boot a real openlist-ext binary AND the real
 * Next.js pshare server, then drive the pshare HTTP API exactly as a browser
 * would — create a text share, fetch it, download the content, create a file
 * share, download it, and verify expiry cleanup.
 *
 * Gated behind PSHARE_INTEGRATION=1.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bootOpenList, ensureBinary, type Harness } from "@/__tests__/harness/openlist-bin";
import { startNextApp, type NextApp } from "@/__tests__/harness/next-app";
import { reapOnce } from "@/lib/reaper";
import { openDb, getShare } from "@/lib/share-store";
import { loadConfig, resetConfig } from "@/lib/config";

let ol: Harness;
let app: NextApp;
let dbPath: string;

beforeAll(async () => {
  if (process.env.PSHARE_INTEGRATION !== "1") {
    // eslint-disable-next-line no-console
    console.log("  (skipped: set PSHARE_INTEGRATION=1 to run)");
    return;
  }
  await ensureBinary();
  ol = await bootOpenList();
  dbPath = path.join(mkdtempSync(path.join(tmpdir(), "pshare-api-")), "pshare.db");
  app = await startNextApp({ openlistBaseUrl: ol.baseUrl, dbPath });
}, 180_000);

afterAll(async () => {
  if (app) await app.teardown();
  if (ol) await ol.teardown();
});

describe("pshare HTTP API end-to-end", () => {
  it("creates a text share and returns a share url", async () => {
    if (!app) return;
    const r = await fetch(`${app.baseUrl}/api/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "integration text", ttl: 3600, maxDownloads: 0 }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.id).toMatch(/^[a-z2-7]{10}$/);
    expect(body.url).toBe(`/s/${body.id}`);
    expect(body.type).toBe("text");
  });

  it("fetches a share and returns a signed download_url", async () => {
    if (!app) return;
    const created = await fetch(`${app.baseUrl}/api/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "fetch me", ttl: 3600 }),
    }).then((r) => r.json());

    const got = await fetch(`${app.baseUrl}/api/share/${created.id}`).then((r) => r.json());
    expect(got.id).toBe(created.id);
    expect(got.type).toBe("text");
    expect(got.download_url).toContain("sign=");
    // download_url is publicly fetchable (no auth).
    const dl = await fetch(got.download_url);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe("fetch me");
  });

  it("creates a file share via multipart and downloads the bytes intact", async () => {
    if (!app) return;
    const bytes = Buffer.from("binary file content \x00\x01\x02");
    const form = new FormData();
    form.append("file", new Blob([bytes]), "data.bin");
    form.append("ttl", "3600");
    const created = await fetch(`${app.baseUrl}/api/share`, {
      method: "POST",
      body: form,
    }).then((r) => r.json());
    expect(created.type).toBe("file");

    const got = await fetch(`${app.baseUrl}/api/share/${created.id}`).then((r) => r.json());
    const dl = await fetch(got.download_url);
    const back = Buffer.from(await dl.arrayBuffer());
    expect(back.equals(bytes)).toBe(true);
  });

  it("returns 404 for an unknown share", async () => {
    if (!app) return;
    const r = await fetch(`${app.baseUrl}/api/share/nonexistent`);
    expect(r.status).toBe(404);
  });

  it("returns 410 and cleans up an expired share", async () => {
    if (!app) return;
    // Create a share with a 1-second TTL.
    const created = await fetch(`${app.baseUrl}/api/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "soon gone", ttl: 1 }),
    }).then((r) => r.json());

    // Wait for it to expire.
    await new Promise((r) => setTimeout(r, 1200));

    const got = await fetch(`${app.baseUrl}/api/share/${created.id}`);
    expect(got.status).toBe(410);

    // The share should now be marked deleted in the DB.
    resetConfig();
    process.env.PSHARE_DB = dbPath;
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    const share = getShare(db, created.id);
    expect(share).toBeNull(); // soft-deleted -> not returned by getShare
  });

  it("enforces a download limit", async () => {
    if (!app) return;
    const created = await fetch(`${app.baseUrl}/api/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "one shot", ttl: 3600, maxDownloads: 1 }),
    }).then((r) => r.json());

    // First fetch succeeds.
    const first = await fetch(`${app.baseUrl}/api/share/${created.id}`);
    expect(first.status).toBe(200);
    // Second fetch: downloads now >= max_downloads -> expired (410).
    const second = await fetch(`${app.baseUrl}/api/share/${created.id}`);
    expect(second.status).toBe(410);
  });

  it("manually deletes a share via DELETE", async () => {
    if (!app) return;
    const created = await fetch(`${app.baseUrl}/api/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "delete me", ttl: 3600 }),
    }).then((r) => r.json());

    const del = await fetch(`${app.baseUrl}/api/share/${created.id}/delete`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    const after = await fetch(`${app.baseUrl}/api/share/${created.id}`);
    expect(after.status).toBe(404);
  });

  it("reaper sweeps expired shares from OpenList", async () => {
    if (!ol || !app) return;
    // Create a share, force-expire it in the DB, then run the reaper.
    const created = await fetch(`${app.baseUrl}/api/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "reap me", ttl: 3600 }),
    }).then((r) => r.json());

    resetConfig();
    process.env.PSHARE_DB = dbPath;
    const cfg = loadConfig();
    const db = openDb(cfg.dbPath);
    db.prepare("UPDATE shares SET expires_at = 1 WHERE id = ?").run(created.id);

    const res = await reapOnce(db, ol.client, Date.now());
    expect(res.deleted).toBeGreaterThanOrEqual(1);

    // File should be gone from OpenList.
    await expect(ol.client.get(`/pshare/${created.id}/paste.txt`)).rejects.toThrow();
  });
});
