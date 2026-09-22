/**
 * Test harness: boot a real openlist-ext binary on a random port with an
 * isolated data directory, mount a Local storage at /pshare, provision a
 * non-admin user with a scoped API key (fs.put/fs.get/fs.rm, CanList=false,
 * TTL enabled), and return everything the static-site tests need.
 *
 * Used by integration and e2e tests so they exercise the actual OpenList API
 * rather than a mock. The returned `apiKey` is exactly what gets baked into a
 * production static build via NEXT_PUBLIC_OPENLIST_API_KEY.
 */
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, existsSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { OpenListClient } from "@/lib/openlist-client";

export type Harness = {
  baseUrl: string;
  /** Scoped API key for the non-admin pshare user (fs.put/fs.get/fs.rm). */
  apiKey: string;
  /** A client already authenticated with the scoped key. */
  client: OpenListClient;
  /** Admin token for any admin-API calls a test needs. */
  adminToken: string;
  dataDir: string;
  teardown: () => Promise<void>;
};

/** Resolve the openlist-ext binary. Built once into /tmp by the test setup. */
export function binaryPath(): string {
  return process.env.OPENLIST_BIN || "/tmp/openlist-ext";
}

const ADMIN_TOKEN = "test-admin-token";
const PERM_WRITE = 1 << 3;
const PERM_REMOVE = 1 << 7;

/** Boot an isolated openlist-ext instance and provision the pshare user/key. */
export async function bootOpenList(opts: { port?: number; adminPassword?: string } = {}): Promise<Harness> {
  const port = opts.port ?? (await freePort());
  const dataDir = mkdtempSync(path.join(tmpdir(), "pshare-ol-"));
  mkdirSync(path.join(dataDir, "data"), { recursive: true });
  const localRoot = path.join(dataDir, "localroot");
  mkdirSync(localRoot, { recursive: true });

  const env = {
    ...process.env,
    // OPENLIST_ADMIN_PASSWORD seeds OpenList's admin password AND lets the
    // extension log in as admin to obtain a real JWT for forwarding
    // API-key-authenticated file ops to OpenList's core (which only accepts
    // JWTs, not the static ADMIN_TOKEN).
    OPENLIST_ADMIN_PASSWORD: opts.adminPassword ?? "admin",
    ADMIN_TOKEN: ADMIN_TOKEN,
    // The extension's loopback client must point at the same port it listens
    // on, or the in-process admin login (for JWT forwarding) targets the
    // wrong address and API-key uploads fail with "token is invalidated".
    LISTEN_ADDR: `:${port}`,
    LOOPBACK_ADDR: `http://127.0.0.1:${port}`,
  };
  const args = [
    "-listen", `:${port}`,
    "-loopback", `http://127.0.0.1:${port}`,
    "-data-dir", path.join(dataDir, "data"),
    "-db", path.join(dataDir, "data", "ext.db"),
    // Short reaper interval so the per-file TTL test (2s expiry) sees the
    // file deleted within its 10s poll window. Production uses the 60s
    // default.
    "-reaper-interval", "1",
  ];
  const child = spawn(binaryPath(), args, { env, stdio: ["ignore", "pipe", "pipe"] });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  // The core OpenList admin API (/api/admin/*) requires a real admin JWT from
  // /api/auth/login; the extension admin API (/ext/admin/*) accepts the static
  // ADMIN_TOKEN. Log in as admin to get the JWT for core calls.
  const adminPassword = opts.adminPassword ?? "admin";
  const jwt = await adminLogin(baseUrl, "admin", adminPassword);
  const admin = makeAdmin(baseUrl, jwt, ADMIN_TOKEN);
  await admin.ensureLocalStorage("/pshare", localRoot);

  // Provision the non-admin pshare user + scoped key.
  const username = "pshare";
  const password = "pshare-test-pw";
  await admin.createUser(username, password, PERM_WRITE | PERM_REMOVE, "/pshare");
  const userId = await admin.findUserId(username);
  await admin.setListPerm(userId, false, true);
  await admin.setTTL(userId, true, "fixed", 86400);
  const apiKey = await admin.createAPIKey(userId, "pshare-test", ["fs.put", "fs.get", "fs.rm"]);

  const client = new OpenListClient({ openlistBaseUrl: baseUrl, openlistApiKey: apiKey });

  return {
    baseUrl,
    apiKey,
    client,
    adminToken: ADMIN_TOKEN,
    dataDir,
    teardown: async () => {
      try {
        child.kill("SIGTERM");
        await once(child, "exit");
      } catch {}
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** Log in as admin via the core OpenList auth API and return the JWT. */
async function adminLogin(baseUrl: string, username: string, password: string): Promise<string> {
  const r = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const j = (await r.json().catch(() => ({}))) as { code: number; message?: string; data?: { token: string } };
  if (j.code !== 200 || !j.data?.token) {
    throw new Error(`admin login failed: ${j.message || r.status}`);
  }
  return j.data.token;
}

/**
 * Minimal admin-API helper. Core OpenList admin routes (/api/admin/*) need the
 * admin JWT; extension admin routes (/ext/admin/*) accept the static extension
 * token. The right token is picked per path.
 */
function makeAdmin(baseUrl: string, jwt: string, extToken: string) {
  function tokenFor(p: string): string {
    return p.startsWith("/ext/admin/") ? extToken : jwt;
  }
  async function req<T = unknown>(p: string, init: { method: string; body?: unknown }): Promise<T> {
    const r = await fetch(`${baseUrl}${p}`, {
      method: init.method,
      headers: { Authorization: tokenFor(p), "Content-Type": "application/json" },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const j = (await r.json().catch(() => ({}))) as { code: number; message?: string; data?: T };
    if (j.code !== 200) throw new Error(`${p} failed: ${j.message || r.status}`);
    return j.data as T;
  }
  return {
    async ensureLocalStorage(mountPath: string, rootFolder: string): Promise<void> {
      const list = await req<{ content: Array<{ mount_path: string }> }>(
        "/api/admin/storage/list?page=1&per_page=1000",
        { method: "GET" },
      ).catch(() => ({ content: [] }));
      if (list.content?.some((s) => s.mount_path === mountPath)) return;
      await req("/api/admin/storage/create", {
        method: "POST",
        body: {
          mount_path: mountPath,
          driver: "Local",
          order: 0,
          cache_expiration: 0,
          status: "work",
          addition: JSON.stringify({
            root_folder_path: rootFolder,
            thumbnail: false,
            show_hidden: true,
            mkdir_perm: "777",
          }),
          remark: "pshare",
          enable_sign: false,
          web_proxy: true,
          proxy_range: true,
        },
      });
    },
    async createUser(username: string, password: string, permission: number, basePath: string): Promise<void> {
      try {
        await req("/api/admin/user/create", {
          method: "POST",
          body: { username, password, permission, base_path: basePath, disabled: false },
        });
      } catch (e) {
        if (!/exist|duplicate|already/i.test((e as Error).message)) throw e;
      }
    },
    async findUserId(username: string): Promise<number> {
      type User = { id: number; username?: string; user_name?: string };
      const data = await req<{ list?: User[]; content?: User[] } | User[]>(
        "/api/admin/user/list?page=1&per_page=1000",
        { method: "GET" },
      );
      // OpenList returns {content: User[], total} for the user list (and some
      // versions {list: User[]} or a bare array). Handle all three shapes.
      const list: User[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.content)
          ? data.content
          : Array.isArray(data?.list)
            ? data.list
            : [];
      const found = list.find((u) => (u.username || u.user_name) === username);
      if (!found) throw new Error(`user ${username} not found`);
      return found.id;
    },
    async setListPerm(userId: number, canList: boolean, canRead: boolean): Promise<void> {
      await req(`/ext/admin/listperm/${userId}`, {
        method: "PUT",
        body: { can_list: canList, can_read: canRead },
      });
    },
    async setTTL(userId: number, enabled: boolean, mode: string, durationSeconds: number): Promise<void> {
      await req(`/ext/admin/ttl/${userId}`, {
        method: "PUT",
        body: { enabled, mode, duration_seconds: durationSeconds },
      });
    },
    async createAPIKey(userId: number, name: string, scopes: string[]): Promise<string> {
      const key = await req<{ secret: string }>(`/ext/admin/apikey`, {
        method: "POST",
        body: { user_id: userId, name, scopes },
      });
      if (!key?.secret) throw new Error(`apikey response had no secret: ${JSON.stringify(key)}`);
      return key.secret;
    },
  };
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

function once(child: ChildProcess, evt: string): Promise<void> {
  return new Promise((res) => {
    child.once(evt, () => res());
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`openlist-ext exited early (code ${child.exitCode})`);
    }
    try {
      const r = await fetch(`${baseUrl}/ext/healthz`);
      if (r.ok) return;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`openlist-ext did not become healthy at ${baseUrl} (${lastErr})`);
}

/**
 * Ensure the openlist-ext binary exists; build it from source if missing.
 *
 * Concurrent-safe: vitest runs each test file in its own worker, so two
 * integration files may call this simultaneously. A lockfile (next to the
 * binary) serializes the build — the first worker builds, the rest wait for
 * the lock, then find the binary already present and skip. This avoids
 * double-building (each Go build downloads deps and takes minutes).
 */
export async function ensureBinary(): Promise<void> {
  if (existsSync(binaryPath())) return;
  const src = process.env.OPENLIST_SRC || "/home/ubuntu/Downloads/openlist";
  const lockPath = `${binaryPath()}.lock`;
  const fs = await import("node:fs");

  let acquired = false;
  try {
    openSync(lockPath, "wx");
    acquired = true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw err;
  }

  if (acquired) {
    try {
      console.log(`building openlist-ext from ${src}…`);
      execFileSync("go", ["build", "-o", binaryPath(), "."], { cwd: src, stdio: "inherit" });
    } finally {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // best-effort
      }
    }
    return;
  }

  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    if (existsSync(binaryPath())) return;
    if (!fs.existsSync(lockPath)) {
      return ensureBinary();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`timed out waiting for openlist-ext build at ${binaryPath()}`);
}
