/**
 * Test harness: build the pshare static export with a given OpenList base URL
 * and API key baked in, then serve the `out/` directory on a random port.
 *
 * pshare is a static site (output: "export"), so there is no `next start`
 * server — the built `out/` directory is served as static files. This harness
 * reproduces that exactly, so e2e tests run against the real static bundle.
 */
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
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
  ".woff2": "font/woff2",
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
  const outDir = path.join(root, "out");

  // Build with NEXT_PUBLIC_* env so the config is inlined into the bundle.
  const env = {
    ...process.env,
    NEXT_PUBLIC_OPENLIST_BASE_URL: opts.openlistBaseUrl,
    NEXT_PUBLIC_OPENLIST_API_KEY: opts.apiKey,
    NEXT_PUBLIC_OPENLIST_MOUNT_PATH: opts.mountPath ?? "/pshare",
    NEXT_PUBLIC_PSHARE_DEFAULT_TTL: "86400",
    NEXT_PUBLIC_PSHARE_DEFAULT_TTL_LABEL: "1 day",
  };
  await new Promise<void>((resolve, reject) => {
    const build = spawn("npm", ["run", "build"], { env, stdio: "inherit", cwd: root });
    build.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`next build exited with code ${code}`)),
    );
    build.on("error", reject);
  });

  const port = opts.port ?? (await freePort());
  const server = createServer((req, res) => serveStatic(outDir, req, res));
  await new Promise<void>((r) => server.listen(port, r));
  return {
    baseUrl: `http://127.0.0.1:${port}`,
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
