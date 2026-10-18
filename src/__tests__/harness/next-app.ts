/**
 * Test harness: build the pshare static export with a given OpenList base URL
 * and API key baked in, then serve the `out/` directory on a random port.
 *
 * pshare is a static site (output: "export"), so there is no `next start`
 * server — the built `out/` directory is served as static files. This harness
 * reproduces that exactly, so e2e tests run against the real static bundle.
 *
 * Two variants exist: startStaticSite bakes the connection into the bundle,
 * and startUnconfiguredStaticSite builds with no build-time connection so
 * e2e tests can exercise configuring OpenList from the page at runtime. The
 * unconfigured build is served from a copy of `out/` (the configured build
 * would otherwise overwrite it on disk).
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { cp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import net from "node:net";

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
 */
export async function startStaticSite(opts: {
  openlistBaseUrl: string;
  apiKey: string;
  mountPath?: string;
  port?: number;
}): Promise<StaticSite> {
  const root = path.resolve(__dirname, "../../..");
  const env = {
    ...process.env,
    NEXT_PUBLIC_OPENLIST_BASE_URL: opts.openlistBaseUrl,
    NEXT_PUBLIC_OPENLIST_API_KEY: opts.apiKey,
    NEXT_PUBLIC_OPENLIST_MOUNT_PATH: opts.mountPath ?? "/pshare",
    NEXT_PUBLIC_PSHARE_DEFAULT_TTL: "86400",
    NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL: "1 day",
  };
  await buildStatic(root, env);
  return serveOutDir(path.join(root, "out"), opts.port);
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

async function serveOutDir(outDir: string, port?: number): Promise<StaticSite> {
  const actualPort = port ?? (await freePort());
  const server = createServer((req, res) => serveStatic(outDir, req, res));
  await new Promise<void>((r) => server.listen(actualPort, r));
  return {
    baseUrl: `http://127.0.0.1:${actualPort}`,
    teardown: async () => {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Minimal static file server with .html and SPA fallback to index.html. */
async function serveStatic(root: string, req: IncomingMessage, res: ServerResponse) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
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
