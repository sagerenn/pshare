/**
 * Test harness: build the pshare static export with a given OpenList base URL
 * and API key baked in, then serve the `out/` directory on a random port.
 *
 * pshare is a static site (output: "export"), so there is no `next start`
 * server — the built `out/` directory is served as static files. This harness
 * reproduces that exactly, so e2e tests run against the real static bundle.
 *
 * Two variants exist: startStaticSite bakes the connection into the bundle
 * (optionally under a NEXT_PUBLIC_BASE_PATH sub-path, served under that
 * prefix like GitHub Pages), and startUnconfiguredStaticSite builds with no
 * build-time connection so e2e tests can exercise configuring OpenList from
 * the page at runtime. Each build overwrites `out/` in place, so every
 * variant serves its own snapshot copy (out-configured/, out-unconfigured/,
 * out-basepath/) — the servers read files from disk on every request.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { cp, readFile, rm, stat } from "node:fs/promises";
import { mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";

export type StaticSite = {
  baseUrl: string;
  teardown: () => Promise<void>;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "application/font-woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Build the static export with the given config baked in, then serve `out/`.
 * Resolves when the server is listening.
 *
 * `basePath` builds the bundle for a sub-path deployment (e.g. "/pshare",
 * like GitHub Pages) and serves it under that prefix, exercising the same
 * URL handling a real sub-path host would.
 */
export async function startStaticSite(opts: {
  openlistBaseUrl: string;
  apiKey: string;
  mountPath?: string;
  port?: number;
  basePath?: string;
}): Promise<StaticSite> {
  const root = path.resolve(__dirname, "../../..");
  const env = {
    ...process.env,
    NEXT_PUBLIC_OPENLIST_BASE_URL: opts.openlistBaseUrl,
    NEXT_PUBLIC_OPENLIST_API_KEY: opts.apiKey,
    NEXT_PUBLIC_OPENLIST_MOUNT_PATH: opts.mountPath ?? "/pshare",
    NEXT_PUBLIC_PSHARE_DEFAULT_TTL: "86400",
    NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL: "1 day",
    NEXT_PUBLIC_BASE_PATH: opts.basePath ?? "",
  };
  await buildStatic(root, env);
  // Always serve from a snapshot copy of out/: a later build (global setup
  // builds several bundles) overwrites out/ in place, and this server reads
  // files from disk on every request.
  const serveDir = path.join(root, opts.basePath ? "out-basepath" : "out-configured");
  await rm(serveDir, { recursive: true, force: true });
  await cp(path.join(root, "out"), serveDir, { recursive: true });
  return serveOutDir(serveDir, opts.port, opts.basePath);
}

/**
 * Build the static export with NO build-time OpenList connection — the only
 * way to point it at a backend is the runtime settings on the page. Used by
 * e2e tests for the configure-in-the-browser journey.
 */
export async function startUnconfiguredStaticSite(opts: { port?: number } = {}): Promise<StaticSite> {
  const root = path.resolve(__dirname, "../../..");
  const env = {
    ...process.env,
    NEXT_PUBLIC_OPENLIST_BASE_URL: "",
    NEXT_PUBLIC_OPENLIST_API_KEY: "",
    NEXT_PUBLIC_OPENLIST_MOUNT_PATH: "/pshare",
  };
  await buildStatic(root, env);
  // Serve from a copy so a later configured build overwriting out/ leaves
  // this bundle intact (files are read from disk on every request).
  const serveDir = path.join(root, "out-unconfigured");
  await rm(serveDir, { recursive: true, force: true });
  await cp(path.join(root, "out"), serveDir, { recursive: true });
  return serveOutDir(serveDir, opts.port);
}

function buildStatic(root: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { env, stdio: "inherit", cwd: root });
    build.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`next build exited with code ${code}`)),
    );
    build.on("error", reject);
  });
}

/** One self-signed cert per process for the TLS harness (tests only). */
let tlsCerts: { key: string; cert: string } | null = null;

/**
 * Generate (once) a self-signed certificate for https://127.0.0.1, so specs
 * can run against a secure page context without a CA. Chromium accepts it via
 * Playwright's ignoreHTTPSErrors.
 */
function selfSignedCert(): { key: string; cert: string } {
  if (tlsCerts) return tlsCerts;
  const dir = mkdtempSync(path.join(os.tmpdir(), "pshare-tls-"));
  const keyPath = path.join(dir, "key.pem");
  const certPath = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  tlsCerts = { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  return tlsCerts;
}

/**
 * Serve an already-built bundle snapshot over HTTPS with a self-signed cert —
 * a secure page context (https:// origin), which http servers can't provide.
 * Used by the mixed-content spec: an https page pointed at an http:// OpenList
 * backend is exactly the deployment shape that browsers block (and that pshare
 * must diagnose as mixed content rather than an outage). Requires Playwright's
 * ignoreHTTPSErrors to load.
 */
export async function startTlsStaticSite(outDir: string, port?: number): Promise<StaticSite> {
  const actualPort = port ?? (await freePort());
  const { key, cert } = selfSignedCert();
  const server = createHttpsServer({ key, cert }, (req, res) => serveStatic(outDir, req, res));
  await new Promise<void>((r) => server.listen(actualPort, "127.0.0.1", r));
  return {
    baseUrl: `https://127.0.0.1:${actualPort}`,
    teardown: async () => {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

async function serveOutDir(outDir: string, port?: number, basePath?: string): Promise<StaticSite> {
  const actualPort = port ?? (await freePort());
  const prefix = basePath ? `${basePath.replace(/\/+$/, "")}/` : "";
  const server = createServer((req, res) => serveStatic(outDir, req, res, prefix));
  await new Promise<void>((r) => server.listen(actualPort, r));
  return {
    // The page-reachable root includes the base path, like the deployed URL.
    baseUrl: `http://127.0.0.1:${actualPort}${prefix ? prefix.slice(0, -1) : ""}`,
    teardown: async () => {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/**
 * Minimal static file server with .html and SPA fallback to index.html.
 * `prefix` serves the tree under a base path (e.g. /pshare/foo -> out/foo),
 * mirroring how a sub-path host (GitHub Pages) maps URLs to the artifact.
 */
async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, prefix = "") {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (prefix) {
    if (urlPath === prefix.slice(0, -1)) {
      // A sub-path host (GitHub Pages / nginx) 301s /pshare to /pshare/; the
      // redirect matters for the service-worker scope, which the trailing-
      // slash-less page would fall outside of.
      res.statusCode = 301;
      res.setHeader("Location", prefix);
      res.end();
      return;
    }
    if (urlPath.startsWith(prefix)) urlPath = urlPath.slice(prefix.length - 1);
    else {
      // A path outside the base path (an unprefixed asset) is a real 404 —
      // no SPA fallback, so specs can catch prefix bugs.
      res.statusCode = 404;
      res.end("outside base path");
      return;
    }
  }
  // Try the exact path, then <path>.html (Next export emits s.html for /s),
  // then <path>/index.html, then SPA fallback to index.html.
  const candidates = [
    path.join(root, urlPath),
    path.join(root, `${urlPath}.html`),
    path.join(root, urlPath, "index.html"),
    path.join(root, "index.html"),
  ];
  for (const filePath of candidates) {
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        const data = await readFile(filePath);
        res.setHeader("Content-Type", MIME[path.extname(filePath)] || "application/octet-stream");
        res.end(data);
        return;
      }
    } catch {
      // try next candidate
    }
  }
  res.statusCode = 404;
  res.end("not found");
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => res(p));
    });
  });
}
