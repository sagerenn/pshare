/**
 * Live verification of the preview features against the deployed GitHub
 * Pages site (https://sagerenn.github.io/pshare/). The live bundle ships
 * unconfigured, so this boots a real local OpenList and configures the
 * connection through the live page's panel — the journey a visitor takes —
 * then exercises the share/preview flows end to end in a real browser.
 *
 * Run from the repo root:  node scripts/live-preview-check.mjs
 * Needs the openlist sibling checkout (builds the binary on first run) and
 * the repo's playwright install.
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

const SITE = "https://sagerenn.github.io/pshare/";
const OPENLIST_BIN = process.env.OPENLIST_BIN || "/tmp/openlist-ext";

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}

/** Boot a fresh openlist-ext, mount /pshare (Local), provision a scoped key. */
async function bootOpenList() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "pshare-live-"));
  mkdirSync(path.join(dataDir, "data"), { recursive: true });
  mkdirSync(path.join(dataDir, "root"), { recursive: true });
  const child = spawn(
    OPENLIST_BIN,
    [
      "-listen", `:${port}`,
      "-loopback", `http://127.0.0.1:${port}`,
      "-data-dir", path.join(dataDir, "data"),
      "-db", path.join(dataDir, "data", "ext.db"),
    ],
    {
      env: {
        ...process.env,
        OPENLIST_ADMIN_PASSWORD: "admin",
        ADMIN_TOKEN: "test-admin-token",
        LISTEN_ADDR: `:${port}`,
        LOOPBACK_ADDR: `http://127.0.0.1:${port}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stderr.on("data", () => {});
  // Wait for the HTTP listener.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${baseUrl}/api/public/settings`, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  const EXT = "test-admin-token";
  const api = async (p, method, body) => {
    const r = await fetch(`${baseUrl}${p}`, {
      method,
      headers: {
        Authorization: p.startsWith("/ext/admin/") ? EXT : jwt,
        "Content-Type": "application/json",
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (j.code !== 200) throw new Error(`${p}: ${j.message || r.status}`);
    return j.data;
  };
  // Admin login (JWT) for core admin routes; ext token for /ext/admin/*.
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  }).then((r) => r.json());
  const jwt = login.data.token;
  // Local storage mounted at /pshare (same shape as the test harness).
  await api("/api/admin/storage/create", "POST", {
    mount_path: "/pshare",
    driver: "Local",
    order: 0,
    cache_expiration: 0,
    status: "work",
    addition: JSON.stringify({
      root_folder_path: path.join(dataDir, "root"),
      thumbnail: false,
      show_hidden: true,
      mkdir_perm: "777",
    }),
    remark: "pshare",
    enable_sign: false,
    web_proxy: true,
    proxy_range: true,
  });
  // Non-admin pshare user: write+remove (perm 6), /pshare only.
  await api("/api/admin/user/create", "POST", {
    username: "pshare",
    password: "pshare-live-pw",
    permission: 6,
    base_path: "/pshare",
    disabled: false,
  });
  const users = await api("/api/admin/user/list?page=1&per_page=1000", "GET");
  const user = (users.content || users.list || []).find((u) => (u.username || u.user_name) === "pshare");
  await api(`/ext/admin/listperm/${user.id}`, "PUT", { can_list: false, can_read: true });
  await api(`/ext/admin/ttl/${user.id}`, "PUT", { enabled: true, mode: "fixed", duration_seconds: 86400 });
  const key = await api("/ext/admin/apikey", "POST", {
    user_id: user.id,
    name: "live-check",
    scopes: ["fs.put", "fs.get", "fs.rm"],
  });
  return {
    baseUrl,
    apiKey: key.secret,
    teardown: async () => {
      try { child.kill("SIGTERM"); } catch {}
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const failures = [];
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures.push(name);
};

const ol = await bootOpenList();
console.log(`openlist booted at ${ol.baseUrl}`);
// The deployed site is HTTPS and the backend is http://127.0.0.1, so Chrome
// would normally block the cross-origin local fetches (mixed content /
// Private Network Access). This is a local verification harness only — the
// real deployment pattern is a same-origin or HTTPS backend — so run this one
// browser with those checks disabled.
const browser = await chromium.launch({
  args: [
    "--disable-web-security",
    "--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessRespectPreflightResult",
  ],
});

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("requestfailed", (r) => {
    const err = r.failure()?.errorText || "";
    if (!/ERR_ABORTED/.test(err)) errors.push(`${r.method()} ${r.url().slice(0, 120)} → ${err}`);
  });

  // Configure the live page at the local backend (the visitor journey).
  // (No networkidle: the service worker keeps connections open, so it may
  // never fire; hydration is confirmed by the panel interaction below.)
  await page.goto(SITE);
  await page.getByLabel("OpenList URL").fill(ol.baseUrl);
  await page.getByLabel("API key").fill(ol.apiKey);
  await page.getByRole("button", { name: "Test connection" }).click();
  // The fs/get probe is async; wait for the verdict rather than an instant
  // isVisible() snapshot (which races the in-flight request).
  try {
    await page.locator(".notice-ok").waitFor({ state: "visible", timeout: 15000 });
    check("live panel: Test connection ok", true);
  } catch {
    check("live panel: Test connection ok", false, "no .notice-ok within 15s");
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await check("live panel: saved", await page.getByRole("button", { name: "Create share" }).isEnabled());

  const share = async (file) => {
    await page.getByRole("button", { name: "File" }).click();
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.getByRole("button", { name: "Create share" }).click();
    return page.locator(".result-url input").inputValue();
  };

  // 1. markdown preview (.md defaults to rendered preview).
  const md = "# Live check\n\n**bold** and a table\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
  const mdUrl = await share({ name: "check.md", mimeType: "text/markdown", buffer: Buffer.from(md, "utf8") });
  check("live share link carries base path", /\/pshare\/s\?id=/.test(mdUrl), mdUrl);
  const v = await context.newPage();
  await v.goto(mdUrl);
  check("live .md renders heading", (await v.locator(".md-view h1").textContent()) === "Live check");
  check("live .md renders GFM table", (await v.locator(".md-view td").count()) === 2);
  await v.getByRole("tab", { name: "Source" }).click();
  check("live .md toggles to source", (await v.locator(".text-view").textContent() ?? "").includes("# Live check"));
  await v.close();

  // 2. image preview.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR42mP8z8BQzwAEYAFn0lpeFQAAAABJRU5ErkJggg==",
    "base64",
  );
  const imgUrl = await share({ name: "dot.png", mimeType: "image/png", buffer: png });
  const imgPage = await context.newPage();
  await imgPage.goto(imgUrl);
  const w = await imgPage.locator("img.media").evaluate((i) => i.naturalWidth);
  check("live image decodes (naturalWidth > 0)", w > 0, `w=${w}`);
  await imgPage.close();

  // 3. video preview (record a clip in-browser, share it, play it).
  const clip = await context.newPage().then(async (rec) => {
    try {
      const out = await rec.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 64; canvas.height = 48;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#3366cc"; ctx.fillRect(0, 0, 64, 48);
        const stream = canvas.captureStream(5);
        const mimes = ["video/mp4", "video/webm"].filter((m) => MediaRecorder.isTypeSupported(m));
        const r = new MediaRecorder(stream, { mimeType: mimes[0] });
        const chunks = [];
        r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const done = new Promise((res) => (r.onstop = () => res(new Blob(chunks, { type: mimes[0] }))));
        r.start();
        await new Promise((r2) => setTimeout(r2, 400));
        r.stop();
        const blob = await done;
        const ext = mimes[0].includes("mp4") ? "mp4" : "webm";
        return { ext, data: Array.from(new Uint8Array(await blob.arrayBuffer())) };
      });
      return { name: `clip.${out.ext}`, buffer: Buffer.from(out.data) };
    } finally { await rec.close(); }
  });
  const vidUrl = await share({
    name: clip.name,
    mimeType: clip.name.endsWith(".mp4") ? "video/mp4" : "video/webm",
    buffer: clip.buffer,
  });
  const vidPage = await context.newPage();
  await vidPage.goto(vidUrl);
  const played = await vidPage.locator("video.media").evaluate((el) =>
    new Promise((res) => {
      const ok = () => res(true);
      if (el.ended) return ok();
      el.addEventListener("ended", ok, { once: true });
      el.addEventListener("timeupdate", () => el.currentTime > 0 && ok());
      el.play().catch(() => res(false));
    }),
  );
  check("live video streams and plays", played === true);
  await vidPage.close();

  // 4. audio preview.
  const tone = await context.newPage().then(async (rec) => {
    try {
      const out = await rec.evaluate(async () => {
        const ctx = new AudioContext();
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        osc.frequency.value = 440;
        osc.connect(dest);
        osc.start();
        const mimes = ["audio/webm;codecs=opus", "audio/webm"].filter((m) => MediaRecorder.isTypeSupported(m));
        const r = new MediaRecorder(dest.stream, { mimeType: mimes[0] });
        const chunks = [];
        r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const done = new Promise((res) => (r.onstop = () => res(new Blob(chunks, { type: mimes[0] }))));
        r.start();
        await new Promise((r2) => setTimeout(r2, 300));
        osc.stop(); r.stop();
        await ctx.close();
        const blob = await done;
        return { data: Array.from(new Uint8Array(await blob.arrayBuffer())) };
      });
      return Buffer.from(out.data);
    } finally { await rec.close(); }
  });
  const audUrl = await share({ name: "tone.ogg", mimeType: "audio/ogg", buffer: tone });
  const audPage = await context.newPage();
  await audPage.goto(audUrl);
  const audioPlayed = await audPage.locator("audio.media").evaluate((el) =>
    new Promise((res) => {
      const ok = () => res(true);
      if (el.ended) return ok();
      el.addEventListener("ended", ok, { once: true });
      el.addEventListener("timeupdate", () => el.currentTime > 0 && ok());
      el.play().catch(() => res(false));
    }),
  );
  check("live audio streams and plays", audioPlayed === true);
  await audPage.close();

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  await ol.teardown();
}

console.log(failures.length ? `\n${failures.length} LIVE FAILURES` : "\nALL LIVE PREVIEW CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
