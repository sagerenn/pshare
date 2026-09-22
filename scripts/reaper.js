/**
 * Standalone reaper process. Run with `npm run reaper` to periodically clean
 * up expired/over-limit shares. Self-contained (plain JS, no TS import) so it
 * runs without a build step. In a single-process deployment the in-process
 * reaper is enough; this script is for split deployments.
 */
const path = require("path");
const Database = require("better-sqlite3");

const cfg = {
  openlistBaseUrl: process.env.OPENLIST_BASE_URL || "http://127.0.0.1:5246",
  openlistUsername: process.env.OPENLIST_USERNAME || "admin",
  openlistPassword: process.env.OPENLIST_PASSWORD || "admin",
  dbPath: process.env.PSHARE_DB || "./data/pshare.db",
  reaperIntervalMs: Number(process.env.PSHARE_REAPER_INTERVAL_MS || 60000),
};

// --- minimal OpenList client (mirrors src/lib/openlist-client.ts) ---
let session = null;
async function login() {
  const r = await fetch(`${cfg.openlistBaseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: cfg.openlistUsername, password: cfg.openlistPassword }),
  });
  const b = await r.json();
  if (b.code !== 200 || !b.data?.token) throw new Error(`login failed: ${b.message}`);
  let exp = 0;
  try {
    const p = b.data.token.split(".")[1];
    exp = JSON.parse(Buffer.from(p, "base64url").toString("utf8")).exp * 1000;
  } catch {}
  session = { token: b.data.token, expiresAt: exp };
}

async function token() {
  const now = Date.now();
  // expiresAt === 0 means no exp claim decoded — refresh proactively rather
  // than treating it as never-expiring (mirrors src/lib/openlist-client.ts).
  const stale = !session || session.expiresAt === 0 || now >= session.expiresAt - 60000;
  if (stale) await login();
  return session.token;
}

async function remove(dir, names, _retried = false) {
  const tok = await token();
  const r = await fetch(`${cfg.openlistBaseUrl}/api/fs/remove`, {
    method: "POST",
    headers: { Authorization: tok, "Content-Type": "application/json" },
    body: JSON.stringify({ dir, names }),
  });
  const b = await r.json();
  if (b.code === 401) {
    if (_retried) throw new Error(`remove failed: auth failed after retry (code 401)`);
    session = null;
    return remove(dir, names, true);
  }
  if (b.code !== 200) throw new Error(`remove failed: ${b.message}`);
}

// --- DB ---
const db = new Database(cfg.dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    mime TEXT NOT NULL, size INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    max_downloads INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, deleted_at INTEGER
  );
`);

function listExpired(now) {
  return db
    .prepare(
      `SELECT * FROM shares WHERE deleted_at IS NULL
       AND (expires_at <= ? OR (max_downloads > 0 AND downloads >= max_downloads))`,
    )
    .all(now);
}

function markDeleted(id) {
  db.prepare("UPDATE shares SET deleted_at = ? WHERE id = ?").run(Date.now(), id);
}

async function sweep() {
  const expired = listExpired(Date.now());
  let deleted = 0;
  let failed = 0;
  for (const s of expired) {
    try {
      const p = s.path.replace(/^\/+/, "");
      const idx = p.lastIndexOf("/");
      const dir = idx < 0 ? "/" : "/" + p.slice(0, idx);
      const name = idx < 0 ? p : p.slice(idx + 1);
      await remove(dir, [name]);
      markDeleted(s.id);
      deleted++;
    } catch (e) {
      console.error(`failed to delete ${s.id}: ${e.message}`);
      failed++;
    }
  }
  if (deleted || failed) console.log(`sweep: deleted=${deleted} failed=${failed}`);
}

console.log(`reaper running every ${cfg.reaperIntervalMs}ms against ${cfg.openlistBaseUrl}`);
const timer = setInterval(sweep, cfg.reaperIntervalMs);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    clearInterval(timer);
    db.close();
    process.exit(0);
  });
}
