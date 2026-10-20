/**
 * Live verification of sub-path OpenList deployments against the deployed
 * GitHub Pages site (https://sagerenn.github.io/pshare/): boots a real local
 * OpenList and puts a prefix-stripping reverse proxy (the Caddy
 * handle_path / nginx proxy_pass-with-slash shape) in front of it, then
 * configures the LIVE page with the public proxied URL
 * (http://127.0.0.1:<port>/openlist) — exactly how an OpenList deployed at
 * https://host/openlist/ by caddy/nginx/httpd looks to a visitor — and runs
 * the share + preview journey end to end.
 *
 * The deployed site is HTTPS and the backend chain is http://127.0.0.1, so
 * this local harness launches Chromium with the Private Network Access /
 * mixed-content checks disabled (real deployments use an HTTPS or same-origin
 * backend; the PNA-disabled browser is a verification tool only).
 *
 * Run from the repo root:  node scripts/live-subpath-check.mjs
 */
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import path from "node:path";
import net from "node:net";

const SITE = "https://sagerenn.github.io/pshare/";
const PREFIX = "/openlist";
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
  const dataDir = mkdtempSync(path.join(tmpdir(), "pshare-sub-"));
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
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${baseUrl}/api/public/settings`, { signal: AbortSignal.timeout(500) });
      if (r.status < 500) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const EXT = "test-admin-token";
  let jwt = "";
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
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin" }),
  }).then((r) => r.json());
  jwt = login.data.token;
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
    name: "live-sub",
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

/** A prefix-stripping reverse proxy: /openlist/x → backend /x (Caddy handle_path shape). */
async function bootStripProxy(targetPort) {
  const port = await freePort();
  const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "host", "content-length"]);
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url || "/", "http://x");
      let targetPath = url.pathname + url.search;
      if (url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`)) {
        targetPath = url.pathname.slice(PREFIX.length) + url.search;
        if (!targetPath.startsWith("/")) targetPath = `/${targetPath}`;
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
      const hasBody = !["GET", "HEAD"].includes(req.method) && chunks.length > 0;
      fetch(`http://127.0.0.1:${targetPort}${targetPath}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
        redirect: "manual",
      })
        .then(async (r) => {
          const out = {};
          for (const [k, v] of r.headers) if (k !== "transfer-encoding" && k !== "content-length") out[k] = v;
          const buf = Buffer.from(await r.arrayBuffer());
          out["content-length"] = String(buf.length);
          res.writeHead(r.status, out);
          res.end(buf);
        })
        .catch(() => {
          res.writeHead(502);
          res.end("strip proxy: upstream unreachable");
        });
    });
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${port}${PREFIX}`,
    teardown: async () => {
      await new Promise((r) => server.close(() => r()));
    },
  };
}

const failures = [];
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures.push(name);
};

const ol = await bootOpenList();
const proxy = await bootStripProxy(Number(new URL(ol.baseUrl).port));
console.log(`openlist at ${ol.baseUrl}, sub-path proxy at ${proxy.baseUrl}`);

// The live site is HTTPS and this backend chain is http://127.0.0.1: disable
// the browser's cross-scheme/local-network blocking — harness-only, as in
// scripts/live-preview-check.mjs.
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

  // The visitor journey: configure the live page with the public sub-path URL.
  await page.goto(SITE);
  await page.getByLabel("OpenList URL").fill(proxy.baseUrl);
  await page.getByLabel("API key").fill(ol.apiKey);
  await page.getByRole("button", { name: "Test connection" }).click();
  try {
    await page.locator(".notice-ok").waitFor({ state: "visible", timeout: 15000 });
    check("live subpath: Test connection ok", true);
  } catch {
    check("live subpath: Test connection ok", false, "no .notice-ok within 15s");
  }
  await page.getByRole("button", { name: "Save", exact: true }).click();

  const share = async (file) => {
    await page.getByRole("button", { name: "File" }).click();
    await page.locator('input[type="file"]').setInputFiles(file);
    await page.getByRole("button", { name: "Create share" }).click();
    return page.locator(".result-url input").inputValue();
  };

  // 1. markdown preview through the sub-path.
  const md = "# Live subpath\n\n**bold** via /openlist\n";
  const mdUrl = await share({ name: "check.md", mimeType: "text/markdown", buffer: Buffer.from(md, "utf8") });
  const v = await context.newPage();
  await v.goto(mdUrl);
  check("live subpath: .md renders heading", (await v.locator(".md-view h1").textContent()) === "Live subpath");
  await v.close();

  // 2. image: must decode from a URL carrying the /openlist prefix (the rebase).
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR42mP8z8BQzwAEYAFn0lpeFQAAAABJRU5ErkJggg==",
    "base64",
  );
  const imgUrl = await share({ name: "dot.png", mimeType: "image/png", buffer: png });
  const imgPage = await context.newPage();
  await imgPage.goto(imgUrl);
  const src = await imgPage.locator("img.media").getAttribute("src");
  check("live subpath: img src carries the prefix (rebased)", src !== null && src.includes("/openlist/"), String(src).slice(0, 90));
  const w = await imgPage.locator("img.media").evaluate((i) => i.naturalWidth);
  check("live subpath: image decodes (naturalWidth > 0)", w > 0, `w=${w}`);
  await imgPage.close();

  // 3. video plays through the prefixed signed URL.
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
  const vsrc = await vidPage.locator("video.media").getAttribute("src");
  check("live subpath: video src carries the prefix (rebased)", vsrc !== null && vsrc.includes("/openlist/"), String(vsrc).slice(0, 90));
  const played = await vidPage.locator("video.media").evaluate((el) =>
    new Promise((res) => {
      const ok = () => res(true);
      if (el.ended) return ok();
      el.addEventListener("ended", ok, { once: true });
      el.addEventListener("timeupdate", () => el.currentTime > 0 && ok());
      el.play().catch(() => res(false));
    }),
  );
  check("live subpath: video streams and plays", played === true);
  await vidPage.close();

  check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  await proxy.teardown();
  await ol.teardown();
}

console.log(failures.length ? `\n${failures.length} LIVE FAILURES` : "\nALL LIVE SUBPATH CHECKS PASSED");
process.exit(failures.length ? 1 : 0);
