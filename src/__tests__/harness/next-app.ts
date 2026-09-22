/**
 * Test harness: start the built Next.js pshare server on a random port,
 * pointed at a given OpenList base URL. Uses the production server
 * (`next start`) so the API routes run exactly as they would in deployment.
 */
import { spawn } from "node:child_process";
import path from "node:path";

export type NextApp = {
  baseUrl: string;
  teardown: () => Promise<void>;
};

/**
 * Start `next start` on a free port with env pointing at the OpenList
 * instance. Resolves when /api/health returns ok.
 */
export async function startNextApp(opts: {
  openlistBaseUrl: string;
  openlistPassword?: string;
  dbPath: string;
  port?: number;
}): Promise<NextApp> {
  const port = opts.port ?? (await freePort());
  const env = {
    ...process.env,
    OPENLIST_BASE_URL: opts.openlistBaseUrl,
    OPENLIST_USERNAME: "admin",
    OPENLIST_PASSWORD: opts.openlistPassword ?? "admin",
    OPENLIST_MOUNT_PATH: "/pshare",
    PSHARE_DB: opts.dbPath,
    PSHARE_MAX_BYTES: "104857600",
    PORT: String(port),
  };
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    cwd: path.resolve(__dirname, "../../.."),
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl, child);

  return {
    baseUrl,
    teardown: async () => {
      try {
        child.kill("SIGTERM");
        await once(child, "exit");
      } catch {}
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

function once(child: ReturnType<typeof spawn>, evt: string): Promise<void> {
  return new Promise((res) => {
    child.once(evt, () => res());
  });
}

async function waitForHealth(baseUrl: string, child: ReturnType<typeof spawn>, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  let lastErr = "";
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`next start exited (code ${child.exitCode})`);
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      if (r.ok) return;
    } catch (e) {
      lastErr = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`next app did not become healthy at ${baseUrl} (${lastErr})`);
}
