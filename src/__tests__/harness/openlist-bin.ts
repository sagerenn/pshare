/**
 * Test harness: boot a real openlist-ext binary on a random port with an
 * isolated data directory, mount a Local storage at /pshare, and return a
 * client plus a teardown function. Used by integration and e2e tests so they
 * exercise the actual OpenList API rather than a mock.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenListClient } from "@/lib/openlist-client";

export type Harness = {
  baseUrl: string;
  client: OpenListClient;
  dataDir: string;
  teardown: () => Promise<void>;
};

/** Resolve the openlist-ext binary. Built once into /tmp by the test setup. */
export function binaryPath(): string {
  return process.env.OPENLIST_BIN || "/tmp/openlist-ext";
}

/** Boot an isolated openlist-ext instance. Resolves when /ext/healthz is up. */
export async function bootOpenList(opts: { port?: number; adminPassword?: string } = {}): Promise<Harness> {
  const port = opts.port ?? (await freePort());
  const dataDir = mkdtempSync(path.join(tmpdir(), "pshare-ol-"));
  mkdirSync(path.join(dataDir, "data"), { recursive: true });
  const localRoot = path.join(dataDir, "localroot");
  mkdirSync(localRoot, { recursive: true });

  const env = {
    ...process.env,
    OPENLIST_ADMIN_PASSWORD: opts.adminPassword ?? "admin",
    ADMIN_TOKEN: "test-admin-token",
  };
  const args = [
    "-listen",
    `:${port}`,
    "-data-dir",
    path.join(dataDir, "data"),
    "-db",
    path.join(dataDir, "data", "ext.db"),
  ];
  const child = spawn(binaryPath(), args, { env, stdio: ["ignore", "pipe", "pipe"] });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  const client = new OpenListClient({
    openlistBaseUrl: baseUrl,
    openlistUsername: "admin",
    openlistPassword: opts.adminPassword ?? "admin",
  });
  await client.login();
  await client.ensureLocalStorage("/pshare", localRoot);

  return {
    baseUrl,
    client,
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

import net from "node:net";
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

/** Ensure the openlist-ext binary exists; build it from source if missing. */
export async function ensureBinary(): Promise<void> {
  if (existsSync(binaryPath())) return;
  const src = process.env.OPENLIST_SRC || "/home/ubuntu/Downloads/openlist";
  const { execFileSync } = await import("node:child_process");
  console.log(`building openlist-ext from ${src}…`);
  execFileSync("go", ["build", "-o", binaryPath(), "."], { cwd: src, stdio: "inherit" });
}
