/**
 * Test harness: a minimal reverse proxy in front of the booted OpenList, for
 * e2e coverage of sub-path deployments ("OpenList behind Caddy / nginx /
 * httpd at /openlist").
 *
 * `mode: "strip"` mimics Caddy's `handle_path /openlist/*` or an nginx
 * `location /openlist/ { proxy_pass http://backend/; }` (the trailing slash
 * form): the /openlist prefix is removed before forwarding. That is the shape
 * where OpenList itself serves at the root and pshare must carry the prefix
 * on every URL it builds — including rebasing the absolute raw_url OpenList
 * mints from its own loopback origin.
 *
 * `mode: "passthrough"` mimics `proxy_pass http://backend` without a path:
 * the prefix is forwarded untouched, for OpenList instances configured with a
 * matching site_url.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "host",
  "content-length",
]);

export type PrefixProxy = {
  /** The public base URL, prefix included (what pshare is configured with). */
  baseUrl: string;
  teardown: () => Promise<void>;
};

export async function startPrefixProxy(opts: {
  targetPort: number;
  prefix: string;
  port?: number;
  mode?: "strip" | "passthrough";
}): Promise<PrefixProxy> {
  const prefix = opts.prefix.replace(/\/+$/, "");
  const mode = opts.mode ?? "strip";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => {});
    req.on("end", () => {
      const url = new URL(req.url || "/", "http://x");
      let targetPath = url.pathname + url.search;
      if (mode === "strip" && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) {
        targetPath = url.pathname.slice(prefix.length) + url.search;
        if (!targetPath.startsWith("/")) targetPath = `/${targetPath}`;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (!HOP_BY_HOP.has(k)) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }
      const hasBody = !["GET", "HEAD"].includes(req.method || "GET") && chunks.length > 0;
      fetch(`http://127.0.0.1:${opts.targetPort}${targetPath}`, {
        method: req.method,
        headers,
        body: hasBody ? Buffer.concat(chunks) : undefined,
        redirect: "manual",
      })
        .then(async (r) => {
          const out: Record<string, string> = {};
          for (const [k, v] of r.headers) if (k !== "transfer-encoding" && k !== "content-length") out[k] = v;
          const buf = Buffer.from(await r.arrayBuffer());
          out["content-length"] = String(buf.length);
          res.writeHead(r.status, out);
          res.end(buf);
        })
        .catch(() => {
          res.writeHead(502);
          res.end("prefix proxy: upstream unreachable");
        });
    });
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}${prefix}`,
    teardown: async () => {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
