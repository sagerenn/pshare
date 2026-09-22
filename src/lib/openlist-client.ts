/**
 * OpenList HTTP client. A thin wrapper around OpenList's public REST API
 * (the same surface documented in /home/ubuntu/Downloads/openlist). pshare
 * authenticates once as a configured user, caches the JWT, and refreshes it
 * transparently when it expires or is rejected.
 *
 * All file operations target a single mount path (default /pshare). Visitors
 * never see this client or its token — it lives entirely server-side.
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

/** A logged-in session token plus its expiry (epoch ms). */
type Session = {
  token: string;
  /** When the token expires, decoded from the JWT `exp` claim. */
  expiresAt: number;
};

const TOKEN_REFRESH_LEAD_MS = 60_000;

/** Decode the `exp` claim from a JWT without verifying (we trust OpenList). */
function jwtExp(token: string): number {
  try {
    const part = token.split(".")[1];
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

export class OpenListClient {
  private readonly base: string;
  private readonly username: string;
  private readonly password: string;
  private session: Session | null = null;
  /** Injected for tests; in production this is global fetch. */
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: Pick<Config, "openlistBaseUrl" | "openlistUsername" | "openlistPassword">, fetchImpl?: typeof fetch) {
    this.base = cfg.openlistBaseUrl.replace(/\/+$/, "");
    this.username = cfg.openlistUsername;
    this.password = cfg.openlistPassword;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /** Log in and cache the session token. */
  async login(): Promise<void> {
    const resp = await this.fetchImpl(`${this.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    const body = (await resp.json()) as OpenListResp<{ token: string }>;
    if (body.code !== 200 || !body.data?.token) {
      throw new Error(`openlist login failed: ${body.message}`);
    }
    this.session = { token: body.data.token, expiresAt: jwtExp(body.data.token) };
  }

  /** Return a valid token, logging in or refreshing as needed. */
  async token(): Promise<string> {
    const now = Date.now();
    // Refresh if we have no session, or if the token is within the refresh
    // lead time of expiry. expiresAt === 0 means we couldn't decode an exp
    // claim — treat that as "unknown, refresh proactively" rather than
    // "never expires", so we don't rely solely on the 401 retry path.
    const stale =
      !this.session ||
      this.session.expiresAt === 0 ||
      now >= this.session.expiresAt - TOKEN_REFRESH_LEAD_MS;
    if (stale) {
      await this.login();
    }
    return this.session!.token;
  }

  /** Drop the cached session so the next call re-logs in. */
  invalidate(): void {
    this.session = null;
  }

  /** Perform an authenticated JSON request, retrying once on auth failure. */
  private async doJson<T>(
    path: string,
    init: { method: string; body?: unknown; token?: string },
  ): Promise<T> {
    const tok = init.token ?? (await this.token());
    const resp = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method,
      headers: {
        Authorization: tok,
        "Content-Type": "application/json",
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    let body: OpenListResp<T>;
    try {
      body = (await resp.json()) as OpenListResp<T>;
    } catch {
      throw new Error(`openlist ${path}: non-JSON response (status ${resp.status})`);
    }
    // 401 => token expired/invalid; refresh and retry once.
    if (body.code === 401 && !init.token) {
      this.invalidate();
      return this.doJson<T>(path, { ...init, token: await this.token() });
    }
    if (body.code !== 200) {
      throw new Error(`openlist ${path}: ${body.message} (code ${body.code})`);
    }
    return body.data;
  }

  /** List a directory. Returns entries plus the total count. */
  async list(path: string): Promise<{ content: DirEntry[]; total: number }> {
    const r = await this.doJson<{ content: DirEntry[] | null; total: number }>("/api/fs/list", {
      method: "POST",
      body: { path, page: 1, per_page: 1000, refresh: false },
    });
    // OpenList returns content: null for an empty directory.
    return { content: r.content ?? [], total: r.total ?? 0 };
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
   * Upload a file by streaming its body to /api/fs/put. The body may be a
   * Buffer, a string, a Blob, or a ReadableStream. When the body is a stream
   * Node's fetch requires `duplex: "half"`. On a 401 we refresh the token and
   * retry exactly once; a second 401 is thrown so a persistently-rejected
   * token can't recurse forever.
   */
  async upload(path: string, body: BodyInit, size?: number, _retried = false): Promise<void> {
    const tok = await this.token();
    const isStream =
      typeof (body as { getReader?: unknown })?.getReader === "function" ||
      (typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
    const resp = await this.fetchImpl(`${this.base}/api/fs/put`, {
      method: "PUT",
      headers: {
        Authorization: tok,
        "File-Path": encodeURIComponent(path),
        "As-Task": "false",
        "Overwrite": "true",
        ...(size !== undefined ? { "Content-Length": String(size) } : {}),
      },
      body,
      // Node fetch requires duplex:"half" for streaming bodies. The cast is
      // because lib.dom.d.ts doesn't include `duplex` on RequestInit.
      ...(isStream ? { duplex: "half" } : {}),
    } as RequestInit);
    let envelope: OpenListResp<unknown>;
    try {
      envelope = (await resp.json()) as OpenListResp<unknown>;
    } catch {
      throw new Error(`openlist upload ${path}: non-JSON response (status ${resp.status})`);
    }
    if (envelope.code === 401) {
      if (_retried) {
        throw new Error(`openlist upload ${path}: auth failed after retry (code 401)`);
      }
      this.invalidate();
      return this.upload(path, body, size, true);
    }
    if (envelope.code !== 200) {
      throw new Error(`openlist upload ${path}: ${envelope.message} (code ${envelope.code})`);
    }
  }

  /**
   * Ensure a Local driver storage is mounted at the given path, rooted at
   * the given local folder. Used by the test harness to bootstrap a clean
   * OpenList instance. In production you mount this yourself.
   */
  async ensureLocalStorage(mountPath: string, rootFolder: string): Promise<void> {
    // List existing storages; if one already exists at mountPath, leave it.
    try {
      const list = await this.doJson<{ content: Array<{ mount_path: string }> }>(
        "/api/admin/storage/list?page=1&per_page=1000",
        { method: "GET" },
      );
      if (list.content?.some((s) => s.mount_path === mountPath)) return;
    } catch {
      // ignore — try to create anyway
    }
    const addition = JSON.stringify({
      root_folder_path: rootFolder,
      thumbnail: false,
      show_hidden: true,
      mkdir_perm: "777",
    });
    await this.doJson("/api/admin/storage/create", {
      method: "POST",
      body: {
        mount_path: mountPath,
        driver: "Local",
        order: 0,
        cache_expiration: 0,
        status: "work",
        addition,
        remark: "pshare",
        enable_sign: false,
        web_proxy: true,
        proxy_range: true,
      },
    });
  }
}
