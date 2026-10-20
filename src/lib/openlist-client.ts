/**
 * OpenList HTTP client for the browser. pshare is a static site, so this
 * client runs entirely in the visitor's browser and talks directly to the
 * OpenList backend using a non-admin user's API key (passed as
 * `Authorization: Bearer <key>`). The key is scope-limited (fs.put / fs.get
 * / fs.rm) and has listing disabled, so it can only create, read, and delete
 * files under the configured mount path — exactly what a no-login temporary
 * sharing site needs.
 *
 * CORS is enabled by default on OpenList (Allow-Origin *), so cross-origin
 * browser calls work out of the box.
 */
import type { Config } from "./config";

/** Standard OpenList response envelope. */
export type OpenListResp<T> = {
  code: number;
  message: string;
  data: T;
};

/** A directory entry returned by /api/fs/list. */
export type DirEntry = {
  name: string;
  size: number;
  is_dir: boolean;
  modified: string;
  sign?: string;
  thumb?: string;
  type?: number;
};

/** File info returned by /api/fs/get, including a public download URL. */
export type FileInfo = DirEntry & {
  raw_url: string;
  provider?: string;
};

/**
 * OpenList returns code 200 inside the JSON envelope on success; anything
 * else is an error. Some failures (e.g. object not found) come back as
 * HTTP 200 with a non-200 code in the body, so we parse the envelope rather
 * than relying on resp.ok.
 */
export class OpenListError extends Error {
  /** The OpenList envelope code (e.g. 404, 403, 500). */
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "OpenListError";
    this.code = code;
  }
}

export class OpenListClient {
  private readonly base: string;
  private readonly apiKey: string;
  /** Injected for tests; in the browser this is global fetch. */
  private readonly fetchImpl: typeof fetch;

  constructor(
    cfg: Pick<Config, "openlistBaseUrl" | "openlistApiKey">,
    fetchImpl?: typeof fetch,
  ) {
    this.base = cfg.openlistBaseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.openlistApiKey;
    // In the browser, the bare `fetch` reference loses its `window` binding
    // when stored and called later, throwing "Illegal invocation". Bind it
    // to the global so it keeps its native context. (Tests inject their own
    // fetch, which is already a plain function and unaffected.)
    this.fetchImpl = fetchImpl ?? fetch.bind(globalThis);
  }

  /** The Authorization header value for the static API key. */
  private authHeader(): string {
    return `Bearer ${this.apiKey}`;
  }

  /** Perform an authenticated JSON request and unwrap the envelope. */
  private async doJson<T>(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<T> {
    const resp = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method,
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    let body: OpenListResp<T>;
    try {
      body = (await resp.json()) as OpenListResp<T>;
    } catch {
      throw new OpenListError(resp.status, `non-JSON response (status ${resp.status})`);
    }
    if (body.code !== 200) {
      throw new OpenListError(body.code, body.message || `code ${body.code}`);
    }
    return body.data;
  }

  /** Get a single file's info, including its public `raw_url`. */
  async get(path: string): Promise<FileInfo> {
    return this.doJson<FileInfo>("/api/fs/get", { method: "POST", body: { path } });
  }

  /** Remove one or more files in a directory. */
  async remove(dir: string, names: string[]): Promise<void> {
    await this.doJson<unknown>("/api/fs/remove", { method: "POST", body: { dir, names } });
  }

  /**
   * Upload a file by streaming its body to /api/fs/put. The body is a Blob
   * (or any BodyInit the browser accepts). `ttlSeconds`, when > 0, is sent
   * as the X-Ttl header to set a per-file TTL that overrides the user's
   * default; when <= 0 the user's default TTL applies.
   *
   * The `File-Path` header is the URL-path-escaped full logical path. The
   * API key (scope fs.put) authorizes the upload; OpenList's CORS default
   * (Allow-Origin *) permits the cross-origin PUT.
   */
  async upload(path: string, body: BodyInit, size?: number, ttlSeconds = 0): Promise<void> {
    const headers: Record<string, string> = {
      Authorization: this.authHeader(),
      "File-Path": encodeURIComponent(path),
      "As-Task": "false",
      "Overwrite": "true",
    };
    if (size !== undefined) headers["Content-Length"] = String(size);
    if (ttlSeconds > 0) headers["X-Ttl"] = String(ttlSeconds);

    const resp = await this.fetchImpl(`${this.base}/api/fs/put`, {
      method: "PUT",
      headers,
      body,
    });
    let envelope: OpenListResp<unknown>;
    try {
      envelope = (await resp.json()) as OpenListResp<unknown>;
    } catch {
      throw new OpenListError(resp.status, `non-JSON response (status ${resp.status})`);
    }
    if (envelope.code !== 200) {
      throw new OpenListError(envelope.code, envelope.message || `code ${envelope.code}`);
    }
  }
}

/**
 * Turn the `raw_url` OpenList returned into a URL the visitor's browser can
 * actually fetch, given the base URL pshare was configured with.
 *
 * OpenList emits raw_url in two shapes:
 *  - a relative proxied path (`/p/...?sign=...`) — join it onto the base.
 *  - an absolute URL, built from OpenList's site_url / loopback address.
 *    For a sub-path deployment behind a reverse proxy (Caddy `handle_path`,
 *    nginx `proxy_pass`, httpd `ProxyPass`), that absolute URL carries the
 *    BACKEND's origin — e.g. `http://127.0.0.1:5244/p/...` — and possibly
 *    the backend's path prefix, not the public URL the visitor can reach.
 *
 * So OpenList's own download routes (`/p/` web-proxy and `/d/` direct) are
 * always rebased onto the configured base (origin + path prefix), which the
 * API calls just proved reachable. Absolute URLs that are NOT OpenList routes
 * — a storage driver's pre-signed S3/OSS URL, an intentional CDN — are used
 * as-is. A root deployment (same origin, no prefix) is returned unchanged,
 * preserving the pre-subpath behavior.
 */
export function resolveRawUrl(base: string, raw: string): string {
  const cleanBase = base.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(raw)) {
    return `${cleanBase}${raw.startsWith("/") ? raw : `/${raw}`}`;
  }
  let b: URL;
  let u: URL;
  try {
    b = new URL(cleanBase);
    u = new URL(raw);
  } catch {
    return raw;
  }
  const basePath = b.pathname.replace(/\/+$/, "");
  // OpenList's own download route paths, with or without the deployment's
  // base-path prefix: /p/x, /d/x, /prefix/p/x, /prefix/d/x.
  const isOlRoute = (p: string) =>
    p.startsWith("/p/") ||
    p.startsWith("/d/") ||
    (basePath !== "" && p.startsWith(`${basePath}/p/`)) ||
    (basePath !== "" && p.startsWith(`${basePath}/d/`));
  // OpenList's own URLs are signed (a bare `sign` query param — observed
  // always present, even with enable_sign off) or unsigned-and-parameterless
  // (/d/ when sign is not required). A pre-signed storage URL (S3's
  // X-Amz-Signature, OSS's Signature) never has a bare `sign=`, so it stays
  // external even if its path coincidentally starts with /p/ or /d/.
  const looksSignedByOl = u.search === "" || /[?&]sign=/.test(u.search);
  if (u.origin === b.origin) {
    if (basePath === "" || u.pathname.startsWith(basePath)) return raw; // already correct
    if (isOlRoute(u.pathname) && looksSignedByOl) {
      // Same host but the OpenList URL is missing the sub-path prefix.
      return `${b.origin}${basePath}${u.pathname}${u.search}`;
    }
    return raw;
  }
  if (isOlRoute(u.pathname) && looksSignedByOl) {
    // The backend's own origin: serve the same route through the public
    // base the API calls already use (adds the sub-path prefix if needed).
    const path =
      basePath !== "" && !u.pathname.startsWith(basePath) ? `${basePath}${u.pathname}` : u.pathname;
    return `${b.origin}${path}${u.search}`;
  }
  return raw; // external pre-signed storage URL, CDN, or unknown — untouched
}
